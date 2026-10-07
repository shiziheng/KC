/** 展示层格式化工具 */

/**
 * 金额格式化。
 * 后端金额单位是「分」（币种为美元），10000 → $100.00
 */
export function formatUSD(fen: number | null | undefined): string {
  const n = typeof fen === 'number' && isFinite(fen) ? fen : 0;
  return '$' + (n / 100).toFixed(2);
}

/** 只要数字部分（用于输入框回填等场景） */
export function toUSDNumber(fen: number | null | undefined): number {
  const n = typeof fen === 'number' && isFinite(fen) ? fen : 0;
  return Number((n / 100).toFixed(2));
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** 2026-10-05 */
export function formatDate(sec: number | null | undefined): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 10-05 12:30 */
export function formatDateTime(sec: number | null | undefined): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 剩余时间：把秒数描述成「25 分 30 秒」 */
export function formatRemain(sec: number): string {
  if (sec <= 0) return '已过期';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m <= 0) return s + ' 秒';
  return m + ' 分 ' + s + ' 秒';
}

/** 邮箱打码：kcbugtest@example.com → kcb****@example.com */
export function maskEmail(email: string): string {
  if (!email || email.indexOf('@') < 0) return email || '';
  const [name, domain] = email.split('@');
  if (name.length <= 3) return name + '***@' + domain;
  return name.slice(0, 3) + '****@' + domain;
}
