/**
 * 兑卡（用卡密开通）
 *
 * 从现有前台（kc_panel_inject 的 openRedeem / renderSessionStep / renderTaskPoll）移植。
 *
 * ⚠️ 这三个接口**不需要登录** —— CDK 本身就是凭证：
 *    兑出来的订阅打在用户自己粘贴的 ChatGPT 账号上，所以「谁去兑」不改变「商品归谁」。
 *    后端是公开接口（带限流 + Origin 校验），前台调用时不必附令牌。
 *
 * ⚠️ 状态字段是 `task_status`（下划线）—— 见 pollRedeem 的注释。
 */

import type { FulfillmentStatus } from './types';

const PREFIX = '/api/pg';

export type CdkState =
  | 'not_found' | 'available' | 'cooldown' | 'processing' | 'completed'
  | 'used' | 'frozen' | 'expired' | 'failed' | 'manual';

export type CdkNextAction = 'provide_credentials' | 'wait' | 'view_order' | 'after_sales' | 'contact_support' | 'none';

export type RedeemVerify = {
  ok: boolean;
  /** 套餐展示名（如「ChatGPT Plus 一个月」） */
  planLabel: string;
  /** 该卡密是否已在开通中（是则直接进进度页） */
  processing: boolean;
  message: string;
  state: CdkState;
  statusLabel: string;
  nextAction: CdkNextAction;
};

export type RedeemProgress = {
  /** 是否终态成功 */
  done: boolean;
  /** 百分比 0~100 */
  progress: number;
  /** 展示文案 */
  message: string;
  /** 失败原因（done=false 且有值时表示失败） */
  error: string;
  state: CdkState;
  statusLabel: string;
  nextAction: CdkNextAction;
};

const POLL_MS = 3000;
const POLL_MAX = 200;   // 10 分钟

const TERMINAL_CDK_STATES = new Set<CdkState>([
  'not_found', 'completed', 'used', 'frozen', 'expired', 'failed', 'manual',
]);

const STATE_LABEL: Record<CdkState, string> = {
  not_found: '未找到', available: '未使用', cooldown: '冷却中', processing: '开通中',
  completed: '已完成', used: '已使用', frozen: '已冻结', expired: '已过期',
  failed: '开通失败', manual: '待人工处理',
};

const STATE_ACTION: Record<CdkState, CdkNextAction> = {
  not_found: 'contact_support', available: 'provide_credentials', cooldown: 'wait',
  processing: 'wait', completed: 'view_order', used: 'view_order', frozen: 'contact_support',
  expired: 'contact_support', failed: 'contact_support', manual: 'contact_support',
};

function validCdkState(raw: unknown): CdkState | null {
  const state = String(raw || '').trim().toLowerCase();
  return (Object.keys(STATE_LABEL) as CdkState[]).includes(state as CdkState) ? state as CdkState : null;
}

/** 将 KC/Xboard 的中英文状态统一为前台 CDK 状态。 */
export function normalizeCdkState(payload: Record<string, unknown> | null | undefined): CdkState {
  const d = payload || {};
  const direct = validCdkState(d.cdk_state) || validCdkState(d.state);
  if (direct) {
    // Xboard 履约 state=pending/running 与 CDK available/processing 语义相近。
    if (direct === 'processing') return 'processing';
    return direct;
  }
  const status = String(d.status_cn || d.status || '').trim();
  const task = String(d.task_status || d.taskStatus || '').toLowerCase();
  if (status === '未找到') return 'not_found';
  if (status === '未使用' || status === '待处理') return 'available';
  if (status === '冷却中') return 'cooldown';
  if (status === '开通中' || status === '处理中' || task === 'running' || task === 'processing') return 'processing';
  if (status === '已完成') return 'completed';
  if (status === '已使用' || task === 'success' || task === 'completed' || task === 'done') return 'used';
  if (status === '已冻结') return 'frozen';
  if (status === '已过期') return 'expired';
  if (status === '待人工处理' || status === 'manual') return 'manual';
  if (status === '开通失败' || task === 'failed' || task === 'fail' || task === 'error') return 'failed';
  return 'processing';
}

function progressFromState(state: CdkState): { done: boolean; error: string } {
  if (state === 'completed') return { done: true, error: '' };
  if (TERMINAL_CDK_STATES.has(state)) return { done: false, error: STATE_LABEL[state] };
  return { done: false, error: '' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(path: string, body?: unknown): Promise<{ ok: boolean; data?: T; message: string; status: number }> {
  try {
    const res = await fetch(PREFIX + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let j: unknown = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    const o = (j || {}) as { status?: string; message?: string; data?: T };
    return {
      ok: res.ok && o.status === 'success',
      data: o.data,
      message: o.message || (res.ok ? '' : '请求失败（' + res.status + '）'),
      status: res.status,
    };
  } catch {
    return { ok: false, message: '网络异常，请稍后重试', status: 0 };
  }
}

/** ① 验证卡密 */
export async function verifyCdk(cdk: string): Promise<RedeemVerify> {
  const res = await call<Record<string, unknown>>(
    '/kc/redeem/verify',
    { cdk }
  );
  const d = res.data || {};
  const state = normalizeCdkState(d);
  if (!res.ok) return {
    ok: false, planLabel: '', processing: false, message: String(d.message || res.message || STATE_LABEL[state] || '卡密验证失败'),
    state, statusLabel: String(d.status_cn || STATE_LABEL[state]), nextAction: (String(d.next_action || STATE_ACTION[state]) as CdkNextAction),
  };

  return {
    ok: true,
    planLabel: String(d.plan_label || d.plan_type || ''),
    // 已在开通中（有任务）→ 不必再要凭据，直接看进度
    processing: state === 'processing' || !!d.job_key,
    message: String(d.message || ''),
    state,
    statusLabel: String(d.status_cn || STATE_LABEL[state]),
    nextAction: (String(d.next_action || STATE_ACTION[state]) as CdkNextAction),
  };
}

/** ② 提交开通 */
export async function startRedeem(cdk: string, session: string): Promise<{ ok: boolean; message: string }> {
  const res = await call('/kc/redeem/start', { cdk, session });
  return { ok: res.ok, message: res.message };
}

/** ③ 查一次进度 */
export async function checkRedeem(cdk: string): Promise<RedeemProgress> {
  const res = await call<{
    task_status?: string;
    taskStatus?: string;
    status?: string;
    status_cn?: string;
    progress?: number;
    message?: string;
    has_task?: boolean;
    state?: string;
    cdk_state?: string;
    terminal?: boolean;
    next_action?: string;
  }>('/kc/redeem/status?cdk=' + encodeURIComponent(cdk));

  if (!res.ok || !res.data) {
    // 网络异常不伪报失败，允许下一轮恢复；明确的 HTTP/业务错误则停止轮询。
    if (res.status === 0) {
      return { done: false, progress: 0, message: '状态暂不可实时更新，正在重试…', error: '', state: 'processing', statusLabel: '开通中', nextAction: 'wait' };
    }
    const state = normalizeCdkState((res.data || {}) as Record<string, unknown>);
    const terminal = state === 'processing' ? 'failed' : state;
    const view = progressFromState(terminal);
    return { done: view.done, progress: 0, message: res.message || STATE_LABEL[terminal], error: view.error || res.message || '状态查询失败', state: terminal, statusLabel: STATE_LABEL[terminal], nextAction: STATE_ACTION[terminal] };
  }

  const d = res.data;
  // ⚠️ 必须优先读 task_status（下划线）。读错字段会导致永远判定不了完成，
  //    直到 5~10 分钟后误报「开通超时」，而账号其实早已开通成功。
  const state = normalizeCdkState(d as Record<string, unknown>);
  const progress = Number.isFinite(Number(d.progress)) ? Number(d.progress) : 0;
  const message = String(d.message || d.status_cn || '');
  const view = progressFromState(state);
  return {
    done: view.done,
    progress: view.done ? 100 : progress,
    message: message || STATE_LABEL[state],
    error: view.error ? (message || view.error) : '',
    state,
    statusLabel: String(d.status_cn || STATE_LABEL[state]),
    nextAction: (String(d.next_action || STATE_ACTION[state]) as CdkNextAction),
  };
}

/**
 * 轮询进度直到终态。
 * `onTick` 每次刷新回调；`shouldStop` 供组件卸载时中止。
 */
export async function pollRedeem(
  cdk: string,
  onTick: (p: RedeemProgress) => void,
  shouldStop?: () => boolean
): Promise<RedeemProgress> {
  for (let n = 0; n <= POLL_MAX; n++) {
    if (shouldStop?.()) return { done: false, progress: 0, message: '', error: '已取消', state: 'processing', statusLabel: '已取消', nextAction: 'none' };

    const p = await checkRedeem(cdk);
    onTick(p);

    if (p.done) return p;
    if (p.error) return p;

    if (n === POLL_MAX) {
      return { done: false, progress: p.progress, message: p.message, error: '开通超时，可稍后回来查看进度或联系客服', state: 'processing', statusLabel: '开通中', nextAction: 'wait' };
    }
    await sleep(POLL_MS);
  }
  return { done: false, progress: 0, message: '', error: '开通超时', state: 'processing', statusLabel: '开通中', nextAction: 'wait' };
}

/** 我的卡密列表（需登录，用于订单页关联） */
export async function fetchMyCards(token: string): Promise<
  { trade_no: string; cdk: string; status: string; status_cn: string; plan_type: string; created_at: string; state?: string; state_cn?: string; terminal?: boolean; next_action?: string; message?: string }[]
> {
  try {
    const res = await fetch('/api/pg/user/kc/cards', {
      headers: { Accept: 'application/json', Authorization: token },
    });
    const j = (await res.json().catch(() => ({}))) as { data?: unknown };
    const d = j.data as unknown;
    if (Array.isArray(d)) return d as never[];
    if (d && typeof d === 'object' && Array.isArray((d as { data?: unknown }).data)) {
      return (d as { data: never[] }).data;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * 查询已登录用户订单的统一履约状态。
 *
 * 这里必须和 Xboard 原生订单接口分开请求：订单 status=3 只说明支付订单
 * 已完成，不能据此把第三方代充误报为成功。请求失败时返回 null，页面保留
 * “状态暂不可实时更新”提示，不把网络失败当成完成。
 */
export async function fetchOrderStatus(token: string, tradeNo: string): Promise<FulfillmentStatus | null> {
  if (!token || !tradeNo) return null;
  try {
    const res = await fetch(PREFIX + '/user/kc/status?trade_no=' + encodeURIComponent(tradeNo), {
      headers: { Accept: 'application/json', Authorization: token },
    });
    const j = (await res.json().catch(() => ({}))) as { status?: string; data?: unknown };
    if (!res.ok || j.status !== 'success' || !j.data || typeof j.data !== 'object') return null;
    return j.data as FulfillmentStatus;
  } catch {
    return null;
  }
}
