import type { FulfillmentState } from './types';

const KNOWN_STATES: FulfillmentState[] = [
  'pending', 'validating', 'running', 'completed', 'failed', 'compensating', 'manual',
];

export type FulfillmentPayload = {
  state?: unknown;
  task_status?: unknown;
  taskStatus?: unknown;
  status?: unknown;
  status_cn?: unknown;
};

/** 把新旧接口字段归一到唯一的履约状态机。 */
export function normalizeFulfillmentState(payload: FulfillmentPayload): FulfillmentState {
  const explicit = String(payload.state || '').toLowerCase().trim() as FulfillmentState;
  if (KNOWN_STATES.includes(explicit)) return explicit;

  const task = String(payload.task_status || payload.taskStatus || payload.status || '').toLowerCase().trim();
  const statusCn = String(payload.status_cn || '');
  if (task === 'success' || task === 'done' || task === 'completed' || statusCn === '已使用') return 'completed';
  if (task === 'failed' || task === 'fail' || task === 'error') return 'failed';
  if (statusCn === '未使用') return 'pending';
  if (statusCn === '开通中' || task === 'processing' || task === 'running') return 'running';
  return 'validating';
}

export function isFulfillmentTerminal(state: FulfillmentState): boolean {
  return state === 'completed' || state === 'failed' || state === 'compensating' || state === 'manual';
}
