/**
 * 余额充值流程
 *
 * 从现有前台（kc_panel_inject 的 renderPayStep / createAndPay）移植，参数与顺序完全一致 —— 涉及资金。
 *
 * 链路：
 *   ① GET  /v1/user/order/getPaymentMethod            → 支付方式列表
 *   ② POST /kc/topup/prepare      { amount }          → plan_id（把金额落成一次性充值套餐）
 *   ③ POST /v1/user/order/save    { plan_id, period } → trade_no
 *   ④ POST /v1/user/order/checkout{ trade_no, method }→ { type, data }
 *   ⑤ 轮询 GET /v1/user/order/check?trade_no=          → status 3=完成 / 2=取消
 *   ⑥ GET  /kc/topup/info?trade_no=                    → 到账金额与余额
 *
 * ⚠️ 为什么充值用 `onetime_price` 而不是 `onetime`：
 *    用户端 OrderSave 的校验白名单是**旧版键**，传 'onetime' 会被「套餐周期参数有误」拒绝。
 *    （注意与代充不同：代充用 month_price，充值用 onetime_price）
 *
 * ⚠️ 充值前置拦截：已有**有效订阅**的用户不允许充值余额（防套利），
 *    必须在进入充值前检查，否则用户走到支付才被后端拒绝。
 */

import { api, pg } from '@/lib/api';
import type { PaymentMethod, Subscribe } from '@/lib/types';

/** 充值订单周期键（用户端旧版键，勿改） */
export const TOPUP_PERIOD = 'onetime_price';

/** 金额范围（美元） */
export const MIN_USD = 2;
export const MAX_USD = 500;
export const PRESET_USD = [7, 14, 42, 70];

const POLL_MS = 3000;
const POLL_MAX = 40;   // 2 分钟

export type CheckoutResult = {
  ok: boolean;
  /** -1=0 元单直接完成；0=URL 跳转；1=二维码/内容 */
  type: number;
  /** 支付链接或二维码内容 */
  data: string;
  tradeNo: string;
  message: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ① 支付方式 */
export async function fetchPaymentMethods(): Promise<PaymentMethod[]> {
  const res = await api.get<PaymentMethod[]>('/v1/user/order/getPaymentMethod');
  if (!res.ok) return [];
  const d = res.data as unknown;
  if (Array.isArray(d)) return d as PaymentMethod[];
  // 兼容 { data: [...] } 的嵌套信封
  if (d && typeof d === 'object' && Array.isArray((d as { data?: unknown }).data)) {
    return (d as { data: PaymentMethod[] }).data;
  }
  return [];
}

/** 当前订阅（用于充值前置拦截） */
export async function fetchSubscribe(): Promise<Subscribe | null> {
  const res = await api.get<Subscribe>('/v1/user/getSubscribe');
  return res.ok && res.data ? res.data : null;
}

/** 是否持有有效订阅 */
export function hasActiveSubscribe(sub: Subscribe | null): boolean {
  if (!sub || !sub.plan_id || !sub.expired_at) return false;
  return Number(sub.expired_at) > Math.floor(Date.now() / 1000);
}

/** ②③④ 创建充值订单并拉起支付 */
export async function createTopupOrder(amountFen: number, methodId: number): Promise<CheckoutResult> {
  const fail = (message: string): CheckoutResult => ({ ok: false, type: 0, data: '', tradeNo: '', message });

  // ② 金额 → 一次性充值套餐
  const prep = await pg.post<{ plan_id?: number }>('/user/kc/topup/prepare', { amount: amountFen });
  if (!prep.ok) return fail(prep.message || '充值初始化失败，请稍后重试');
  const planId = prep.data && prep.data.plan_id;
  if (!planId) return fail('套餐准备失败');

  // ③ 下单
  const save = await api.post<string | { data?: string }>('/v1/user/order/save', {
    plan_id: planId,
    period: TOPUP_PERIOD,
  });
  if (!save.ok) return fail(save.message || '订单创建失败');

  const raw = save.data as unknown;
  const tradeNo =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && typeof (raw as { data?: unknown }).data === 'string'
        ? ((raw as { data: string }).data)
        : '';
  if (!tradeNo) return fail('订单创建失败');

  // ④ 结算：这个接口的 type 在**顶层**，不走标准信封，所以直接 fetch
  const res = await fetch('/api/xb/v1/user/order/checkout', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(typeof window !== 'undefined' && localStorage.getItem('kc_token')
        ? { Authorization: localStorage.getItem('kc_token') as string }
        : {}),
    },
    body: JSON.stringify({ trade_no: tradeNo, method: methodId }),
  }).catch(() => null);

  if (!res) return fail('网络异常，请稍后重试');

  const j = (await res.json().catch(() => ({}))) as {
    type?: number;
    data?: unknown;
    message?: string;
    status?: string;
  };

  const type = typeof j.type === 'number' ? j.type : 0;
  // 0 元单（type=-1）没有链接；其余情况 data 可能是链接或二维码内容
  const data = typeof j.data === 'string' ? j.data : '';

  if (!res.ok && !data) return fail(j.message || '支付发起失败');

  return { ok: true, type, data, tradeNo, message: '' };
}

/** ⑤ 查询订单状态：3=已完成 2=已取消 其他=进行中 */
export async function checkOrderStatus(tradeNo: string): Promise<number> {
  const res = await api.get<number | { data?: number }>('/v1/user/order/check?trade_no=' + encodeURIComponent(tradeNo));
  if (!res.ok) return -1;
  const d = res.data as unknown;
  if (typeof d === 'number') return d;
  if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'number') {
    return (d as { data: number }).data;
  }
  return -1;
}

/** ⑥ 到账信息 */
export async function fetchTopupInfo(tradeNo: string): Promise<{ amount: number; balanceAfter: number }> {
  const res = await pg.get<{ amount?: number; balance_after?: number }>(
    '/user/kc/topup/info?trade_no=' + encodeURIComponent(tradeNo)
  );
  if (!res.ok || !res.data) return { amount: 0, balanceAfter: 0 };
  return { amount: Number(res.data.amount || 0), balanceAfter: Number(res.data.balance_after || 0) };
}

export type PayOutcome = {
  status: 'done' | 'cancelled' | 'timeout';
  amount: number;
  balanceAfter: number;
};

/**
 * 等待支付完成（轮询）。
 * `onTick` 用于让 UI 更新等待次数；`shouldStop` 让组件卸载时中止。
 */
export async function waitForPayment(
  tradeNo: string,
  onTick?: (n: number) => void,
  shouldStop?: () => boolean
): Promise<PayOutcome> {
  for (let n = 1; n <= POLL_MAX; n++) {
    if (shouldStop?.()) return { status: 'timeout', amount: 0, balanceAfter: 0 };

    const st = await checkOrderStatus(tradeNo);
    if (st === 3) {
      // 到账由支付回调写入，可能有 1~2 秒延迟 → 多试几次
      for (let k = 0; k < 5; k++) {
        const info = await fetchTopupInfo(tradeNo);
        if (info.amount > 0) return { status: 'done', amount: info.amount, balanceAfter: info.balanceAfter };
        await sleep(800);
      }
      return { status: 'done', amount: 0, balanceAfter: 0 };
    }
    if (st === 2) return { status: 'cancelled', amount: 0, balanceAfter: 0 };

    onTick?.(n);
    await sleep(POLL_MS);
  }
  return { status: 'timeout', amount: 0, balanceAfter: 0 };
}
