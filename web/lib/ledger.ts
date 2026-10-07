import { readToken } from '@/lib/api';
import type { LedgerEntry, LedgerReconciliation } from '@/lib/types';

export type LedgerResponse = {
  entries: LedgerEntry[];
  reconciliation: LedgerReconciliation;
};

/** 用户只读账务流水；失败时返回空结果，不影响个人中心其它功能。 */
export async function fetchMyLedger(): Promise<LedgerResponse | null> {
  const token = readToken();
  if (!token) return null;
  try {
    const res = await fetch('/api/pg/user/kc/ledger?limit=50', {
      headers: { Accept: 'application/json', Authorization: token },
    });
    const j = (await res.json().catch(() => ({}))) as { status?: string; data?: Partial<LedgerResponse> };
    if (!res.ok || j.status !== 'success' || !j.data) return null;
    return {
      entries: Array.isArray(j.data.entries) ? j.data.entries : [],
      reconciliation: j.data.reconciliation || { status: 'not_enough_data', current_balance: 0 },
    };
  } catch {
    return null;
  }
}
