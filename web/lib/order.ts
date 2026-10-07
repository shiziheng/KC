/**
 * 代充开通流程
 *
 * 从现有前台（注入版 kcPaySequential）移植，**步骤顺序与参数完全一致** —— 这段涉及资金，
 * 任何改动都必须先对照旧实现。
 *
 * 单个账号的完整链路：
 *   ① POST /v1/user/order/save        { plan_id, period }      → trade_no（余额自动抵扣）
 *   ② POST /kc/order/pay-balance      { trade_no }             → 推进履约
 *        （Xboard 原生不会自动完成「纯余额抵扣」的订单，必须显式推进）
 *   ③ 轮询 GET /user/kc/card?trade_no= → 系统发卡，拿到 cdk
 *   ④ POST /kc/redeem/start           { cdk, session }         → 提交开通
 *   ⑤ 轮询 GET /kc/redeem/status?cdk=  → 等开通完成
 *
 * ⚠️ 为什么用 `month_price` 而不是 `monthly`：
 *    用户端 OrderSave 校验的是**旧版键**（month_price / onetime_price …），
 *    管理端 plan/save 才用新版键（monthly / onetime …）。用错会在 422 挂掉。
 *
 * ⚠️ 逐账号**串行**处理：一个失败不影响后面的，用户能逐行看到结果。
 */

import { api, pg } from '@/lib/api';
import { isFulfillmentTerminal, normalizeFulfillmentState } from '@/lib/fulfillment';

/** 下单周期键（用户端旧版键，勿改） */
export const ORDER_PERIOD = 'month_price';

const WAIT_CARD_MAX = 40;        // 等发卡：40 × 1.5s = 60s
const WAIT_CARD_INTERVAL = 1500;
const POLL_MAX = 100;            // 等开通：100 × 3s = 300s
const POLL_INTERVAL = 3000;

export type Step =
  | 'pending'    // 等待处理
  | 'ordering'   // 下单中
  | 'opening'    // 开通中
  | 'done'       // 已完成
  | 'failed';    // 失败

export type OpenResult = { ok: boolean; cdk: string; error: string };

type Progress = {
  /** 阶段文案，直接展示给用户 */
  msg: string;
  /** 0~100 */
  progress?: number;
  /** 拿到的卡密（内部用，不展示给用户） */
  cdk?: string;
  /** 订单号 */
  tradeNo?: string;
};

type Options = {
  planId: number;
  session: string;
  onProgress: (p: Progress) => void;
  /** 返回 true 时中止（组件卸载时会话取消） */
  shouldStop?: () => boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 前端请求级幂等锁。
 *
 * 这里只在当前页面生命周期内去重，不保存 Session，也不把 Session 原文放进
 * localStorage/sessionStorage。相同套餐 + 相同账号在请求尚未结束时重复点击，
 * 复用同一个 Promise；服务端仍以 trade_no/CDK 唯一约束作为最终裁决。
 */
const openInFlight = new Map<string, Promise<OpenResult>>();

function requestFingerprint(planId: number, session: string): string {
  // FNV-1a：仅用于内存 Map 的键，不是安全哈希，也不承担鉴权职责。
  let hash = 2166136261;
  for (let i = 0; i < session.length; i++) {
    hash ^= session.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${planId}:${session.length}:${hash >>> 0}`;
}

/** ① 创建订单 */
async function saveOrder(planId: number): Promise<string> {
  const res = await api.post<string | { trade_no?: string }>('/v1/user/order/save', {
    plan_id: planId,
    period: ORDER_PERIOD,
  });
  if (!res.ok) throw new Error(res.message || '下单失败');

  const d = res.data;
  const tradeNo = typeof d === 'string' ? d : (d && d.trade_no) || '';
  if (!tradeNo) throw new Error('未取到订单号');
  return tradeNo;
}

/** ② 余额结算（推进履约） */
async function payWithBalance(tradeNo: string): Promise<void> {
  const res = await pg.post('/kc/order/pay-balance', { trade_no: tradeNo });
  if (!res.ok) throw new Error(res.message || '余额结算失败');
}

/** ③ 等系统发卡 */
async function waitForCard(
  tradeNo: string,
  opts: Options,
  onTick: (n: number) => void
): Promise<string> {
  for (let n = 0; n <= WAIT_CARD_MAX; n++) {
    if (opts.shouldStop?.()) throw new Error('已取消');

    const res = await pg.get<{ cdk?: string }>('/user/kc/card?trade_no=' + encodeURIComponent(tradeNo));
    const cdk = res.ok ? String((res.data && res.data.cdk) || '').trim() : '';
    if (cdk) return cdk;

    if (n === WAIT_CARD_MAX) throw new Error('等待发卡超时，请到「我的订单」查看或联系客服');
    onTick(n + 1);
    await sleep(WAIT_CARD_INTERVAL);
  }
  throw new Error('等待发卡超时');
}

/** ④ 提交开通 */
async function startRedeem(cdk: string, session: string): Promise<void> {
  const res = await pg.post('/kc/redeem/start', { cdk, session });
  if (!res.ok) throw new Error(res.message || '提交开通失败');
}

/** ⑤ 轮询开通进度 */
async function pollRedeemStatus(
  cdk: string,
  opts: Options,
  onTick: (n: number, progress?: number, msg?: string) => void
): Promise<void> {
  for (let n = 0; n <= POLL_MAX; n++) {
    if (opts.shouldStop?.()) throw new Error('已取消');

    const res = await pg.get<{
      status?: string;
      /** ⚠️ 插件返回的真实字段是 `task_status`（下划线），不是 taskStatus */
      task_status?: string;
      taskStatus?: string;
      /** 中文可用性（"已使用" 等），仅用于展示 */
      status_cn?: string;
      progress?: number;
      message?: string;
      text?: string;
      has_task?: boolean;
    }>('/kc/redeem/status?cdk=' + encodeURIComponent(cdk));

    if (res.ok && res.data) {
      const d = res.data;
      // ⚠️ 字段优先级：task_status（插件实际返回）→ taskStatus/status（历史兼容）
      //    读错字段会导致**进度永远判定不了完成**，直到 5 分钟后误报「开通超时」，
      //    而实际上账号可能早已开通成功 —— 旧版前台（kc_theme_inject）就有这个问题。
      const state = normalizeFulfillmentState(d);
      const prog = Number(d.progress);
      const msg = d.message || d.text || d.status_cn;

      if (state === 'completed') return;
      if (isFulfillmentTerminal(state)) {
        throw new Error(state === 'failed' ? '开通失败，请联系客服' : '代充结果待处理，请联系客服');
      }
      onTick(n + 1, Number.isFinite(prog) && prog > 0 ? prog : undefined, msg ? String(msg).slice(0, 80) : undefined);
    } else {
      onTick(n + 1);
    }

    if (n === POLL_MAX) throw new Error('开通超时，可到订单页查看进度或联系客服');
    await sleep(POLL_INTERVAL);
  }
}

/** 完整开通一个账号（实际执行体） */
async function executeOpenOneAccount(opts: Options): Promise<OpenResult> {
  try {
    opts.onProgress({ msg: '正在下单…' });
    const tradeNo = await saveOrder(opts.planId);
    opts.onProgress({ msg: '已扣款，正在完成订单…', tradeNo });

    await payWithBalance(tradeNo);
    opts.onProgress({ msg: '订单已完成，等待系统发卡…', tradeNo });

    const cdk = await waitForCard(tradeNo, opts, (n) => {
      opts.onProgress({ msg: `等待系统发卡…（${n}）`, tradeNo });
    });
    opts.onProgress({ msg: '正在提交开通…', tradeNo, cdk });

    await startRedeem(cdk, opts.session);
    opts.onProgress({ msg: '开通处理中…', tradeNo, cdk });

    await pollRedeemStatus(
      cdk,
      opts,
      (n, prog, msg) => {
        opts.onProgress({ msg: msg || `开通中…${prog ? `（${prog}%）` : ''}`, progress: prog, tradeNo, cdk });
      }
    );

    opts.onProgress({ msg: '开通完成', progress: 100, tradeNo, cdk });
    return { ok: true, cdk, error: '' };
  } catch (e) {
    const err = e as Error;
    return { ok: false, cdk: '', error: err.message || '处理失败' };
  }
}

/** 完整开通一个账号（带当前页面生命周期内的重复请求锁） */
export function openOneAccount(opts: Options): Promise<OpenResult> {
  const key = requestFingerprint(opts.planId, opts.session);
  const existing = openInFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = executeOpenOneAccount(opts);
  const tracked = promise.finally(() => {
    if (openInFlight.get(key) === tracked) {
      openInFlight.delete(key);
    }
  });
  openInFlight.set(key, tracked);
  return tracked;
}

/* ── 批量（串行）── */

export type BatchRow = {
  email: string;
  session: string;
  /** 展示用：该账号当前套餐（Free/Plus/Pro） */
  plan?: string;
  state: Step;
  msg: string;
  progress: number;
  cdk: string;
  tradeNo: string;
};

/**
 * 串行开通一批账号。
 * 回调 `onRow` 在每行状态变化时触发，供 UI 更新（传的是整行快照）。
 */
export async function openBatch(
  items: { email: string; session: string; plan?: string }[],
  planId: number,
  onRow: (index: number, row: BatchRow) => void,
  shouldStop?: () => boolean
): Promise<BatchRow[]> {
  const rows: BatchRow[] = items.map((x) => ({
    email: x.email,
    session: x.session,
    plan: x.plan,
    state: 'pending',
    msg: '等待处理',
    progress: 0,
    cdk: '',
    tradeNo: '',
  }));

  for (let i = 0; i < rows.length; i++) {
    if (shouldStop?.()) break;

    const row = rows[i];
    row.state = 'ordering';
    row.msg = '正在下单…';
    onRow(i, { ...row });

    const r = await openOneAccount({
      planId,
      session: row.session,
      shouldStop,
      onProgress: (p) => {
        if (p.tradeNo) row.tradeNo = p.tradeNo;
        if (p.cdk) row.cdk = p.cdk;
        if (typeof p.progress === 'number') row.progress = Math.min(99, Math.round(p.progress));
        row.msg = p.msg;
        if (row.state === 'ordering' && /提交开通|开通处理中|开通中/.test(p.msg)) row.state = 'opening';
        onRow(i, { ...row });
      },
    });

    if (r.ok) {
      row.state = 'done';
      row.progress = 100;
      row.msg = '开通完成';
      row.cdk = r.cdk;
    } else {
      row.state = 'failed';
      row.msg = r.error;
    }
    onRow(i, { ...row });
  }

  return rows;
}
