/**
 * ChatGPT Session 解析
 *
 * 从现有前台（注入版）移植，逻辑保持一致 —— 这段已经被线上验证过。
 * 支持两种输入：
 *   ① 完整 Session JSON：{"accessToken":"eyJ...","user":{...}}
 *   ② 裸 accessToken（JWT 字符串）
 *
 * ⚠️ 只做本地解析，不校验有效性 —— 有效性由后端开通时判断。
 * ⚠️ 解析结果含敏感令牌，**只留在内存**，不写入 localStorage / sessionStorage。
 */

export type ParsedSession = {
  ok: boolean;
  email: string;
  /** Free / Plus / Pro / 未知 */
  plan: string;
  accountTail: string;
  userTail: string;
  /** 过期时间（unix 秒），0 表示未知 */
  exp: number;
  token: string;
  raw: string;
  reason: string;
  /** 内部用：JSON 尚未闭合，需要继续拼接下一行 */
  parseFailed?: boolean;
};

/** JWT 的 base64url 段解码 */
function decodeJwtPart(part: string): Record<string, unknown> | null {
  try {
    let normalized = String(part || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (normalized.length % 4)) % 4;
    if (pad) normalized += '='.repeat(pad);
    return JSON.parse(atob(normalized)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 套餐键 → 展示名 */
export function planLabel(p: string): string {
  const k = String(p || '').trim();
  if (!k) return '未知';
  const low = k.toLowerCase();
  if (low === 'free' || low === 'chatgpt_free') return 'Free';
  if (low === 'plus' || low === 'chatgpt_plus') return 'Plus';
  if (low.indexOf('pro') === 0 || low.indexOf('chatgpt_pro') === 0) return 'Pro';
  return k;
}

export function parseSessionLine(raw: string): ParsedSession {
  const empty: ParsedSession = {
    ok: false, email: '', plan: '', accountTail: '', userTail: '', exp: 0,
    token: '', raw: String(raw || ''), reason: '',
  };

  const text = String(raw || '').trim();
  if (!text) return { ...empty, reason: '空行' };

  let session: Record<string, unknown> | null = null;
  let token = '';

  if (text.charAt(0) === '{') {
    try {
      session = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // 交给上层继续拼接（多行 JSON）
      return { ...empty, parseFailed: true };
    }
    if (!session || typeof session !== 'object') {
      return { ...empty, reason: 'JSON 结构不识别' };
    }
    token = String(
      (session.accessToken as string) || (session.access_token as string) || ''
    ).trim();
    if (!token) return { ...empty, reason: 'JSON 中缺少 accessToken 字段' };
  } else {
    token = text;
  }

  const parts = token.split('.');
  let payload: Record<string, unknown> | null = null;
  if (parts.length === 3) payload = decodeJwtPart(parts[1]);

  const profile = ((payload && payload['https://api.openai.com/profile']) || {}) as Record<string, unknown>;
  const auth = ((payload && payload['https://api.openai.com/auth']) || {}) as Record<string, unknown>;

  const email =
    (profile.email as string) ||
    ((session && session.user && (session.user as Record<string, unknown>).email) as string) ||
    (payload && (payload.email as string)) ||
    '';

  const planRaw =
    (auth.chatgpt_plan_type as string) ||
    (auth.chatgpt_subscription_plan as string) ||
    (payload && (payload.chatgpt_plan_type as string)) ||
    '';

  const accountId = String(auth.chatgpt_account_id || '');
  const userId = String(auth.chatgpt_user_id || '');

  const exp = Number(
    (session && session.expires && Date.parse(session.expires as string) / 1000) ||
      (payload && (payload.exp as number)) ||
      0
  );

  const ok = !!(payload || email);

  return {
    ok,
    email,
    plan: planLabel(planRaw),
    accountTail: accountId ? accountId.slice(-4) : '',
    userTail: userId ? userId.slice(-4) : '',
    exp,
    token,
    raw: text,
    reason: ok ? '' : '无法解析：既不是 Session JSON，也不是有效 accessToken',
  };
}

/** 批量解析：一行一个；兼容「格式化的多行 JSON」（累积拼接） */
export function parseSessions(text: string): ParsedSession[] {
  const lines = String(text || '').split(/\r?\n/);
  const out: ParsedSession[] = [];
  let buf = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (buf) {
      buf += line;
      const rb = parseSessionLine(buf);
      if (!rb.parseFailed) {
        out.push(rb);
        buf = '';
      } else if (buf.length > 40000) {
        out.push({ ...parseSessionLine(''), ok: false, reason: 'JSON 过长或未闭合' });
        buf = '';
      }
      continue;
    }

    const r = parseSessionLine(line);
    if (r.parseFailed) {
      buf = line;
      continue;
    }
    out.push(r);
  }

  if (buf) {
    out.push({ ...parseSessionLine(''), ok: false, reason: 'JSON 未闭合（可能复制不完整）' });
  }

  return out;
}

/** 已勾选数量 / 可解析数量 */
export function countOk(list: ParsedSession[]): number {
  return list.filter((x) => x.ok).length;
}
