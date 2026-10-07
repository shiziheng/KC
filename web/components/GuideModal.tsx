'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { formatUSD } from '@/lib/format';
import { openBatch, type BatchRow } from '@/lib/order';
import { parseSessions, type ParsedSession } from '@/lib/session';
import type { PlanView } from '@/lib/types';

const STEPS = ['登录账号', '获取 Session', '选择账号', '余额支付'];

type Phase = 'steps' | 'processing' | 'done';

const ROW_LABEL: Record<string, string> = {
  pending: '等待处理',
  ordering: '下单中',
  opening: '开通中',
  done: '已完成',
  failed: '失败',
};

export default function GuideModal({
  view,
  onClose,
}: {
  view: PlanView;
  onClose: () => void;
}) {
  const { user, refresh } = useAuth();

  const [phase, setPhase] = useState<Phase>('steps');
  const [step, setStep] = useState(1);
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<ParsedSession[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [balance, setBalance] = useState<number | null>(user ? user.balance : null);
  const [err, setErr] = useState('');

  const stoppedRef = useRef(false);
  const payingRef = useRef(false);

  /* 关闭时清理（凭证只留内存） */
  const close = useCallback(() => {
    if (payingRef.current) return;   // 支付中不允许关闭
    setRaw('');
    setParsed([]);
    onClose();
  }, [onClose]);

  useEffect(() => {
    stoppedRef.current = false;
    return () => { stoppedRef.current = true; };
  }, []);

  /* Esc 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  /* 锁定滚动 */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  /* 刷新余额 */
  useEffect(() => {
    let alive = true;
    void refresh().then((u) => { if (alive && u) setBalance(u.balance); });
    return () => { alive = false; };
  }, [refresh]);

  const okList = parsed.map((p, i) => ({ p, i })).filter((x) => x.p.ok);
  const pickedRows = picked
    .slice()
    .sort((a, b) => a - b)
    .map((i) => parsed[i])
    .filter((x) => x && x.ok);

  const unitFen = view.plan.month_price || 0;
  const totalFen = unitFen * Math.max(0, pickedRows.length);
  const shortFen = balance != null ? totalFen - balance : 0;

  /* ── 步骤推进 ── */
  const gotoStep = (n: number) => {
    if (payingRef.current) return;
    if (n === 4 && pickedRows.length === 0) {
      setErr('请先勾选至少一个账号，再进入支付步骤');
      setStep(3);
      return;
    }
    setErr('');
    setStep(n);
  };

  const next = () => {
    setErr('');

    if (step === 2) {
      const list = parseSessions(raw);
      if (!list.length) {
        setErr('请粘贴 Session 或 accessToken（每行一个）');
        return;
      }
      const okCount = list.filter((x) => x.ok).length;
      if (!okCount) {
        setErr('没有解析出有效账号，请检查内容是否完整（含 accessToken 字段）');
        setParsed(list);
        return;
      }
      setParsed(list);
      setPicked(list.map((x, i) => (x.ok ? i : -1)).filter((i) => i >= 0));
      setStep(3);
      return;
    }

    if (step === 3) {
      if (pickedRows.length === 0) {
        setErr('请勾选至少一个账号');
        return;
      }
      setStep(4);
      return;
    }

    if (step < 4) setStep(step + 1);
  };

  const togglePick = (i: number) => {
    setPicked((prev) => (prev.indexOf(i) >= 0 ? prev.filter((x) => x !== i) : [...prev, i].sort((a, b) => a - b)));
  };

  /* ── 支付 ── */
  const pay = async () => {
    if (payingRef.current || pickedRows.length === 0) return;
    if (shortFen > 0) { setErr('余额不足，请先充值'); return; }

    payingRef.current = true;
    setErr('');
    setPhase('processing');
    setRows(
      pickedRows.map((p) => ({
        email: p.email, session: String(p.raw || p.token || ''), plan: p.plan,
        state: 'pending' as const, msg: '等待处理', progress: 0, cdk: '', tradeNo: '',
      }))
    );

    const items = pickedRows.map((p) => ({
      email: p.email,
      session: String(p.raw || p.token || ''),
      plan: p.plan,
    }));

    await openBatch(
      items,
      view.plan.id,
      (i, row) => setRows((prev) => {
        if (!prev) return prev;
        const next2 = prev.slice();
        next2[i] = row;
        return next2;
      }),
      () => stoppedRef.current
    );

    payingRef.current = false;
    setPhase('done');
    // 凭证用完即清（只留结果）
    setRaw('');
    setParsed([]);
    setPicked([]);
    void refresh().then((u) => { if (u) setBalance(u.balance); });
  };

  const doneN = (rows || []).filter((r) => r.state === 'done').length;
  const failN = (rows || []).filter((r) => r.state === 'failed').length;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/45 p-4 md:items-center">
      <div className="kc-card my-auto w-full max-w-2xl">
        {/* 头部 */}
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-h3 text-t1">{view.title}</h2>
            <p className="mt-0.5 text-aux text-t3">
              {view.priceNum}
              {view.priceUnit} · 余额 {balance == null ? '读取中…' : formatUSD(balance)}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={phase === 'processing'}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-t3 transition-colors hover:bg-black/[.05] hover:text-t1 disabled:opacity-40"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* 步骤条 */}
        {phase === 'steps' && (
          <div className="border-b border-line px-5 py-3">
            <div className="flex gap-1">
              {STEPS.map((label, i) => {
                const idx = i + 1;
                const on = idx === step;
                const done = idx < step;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => gotoStep(idx)}
                    className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/[.03]"
                  >
                    <span
                      className={
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-aux font-medium ' +
                        (on || done ? 'border-brand bg-brand text-white' : 'border-line text-t3')
                      }
                    >
                      {done ? '✓' : idx}
                    </span>
                    <span className={'hidden text-aux sm:block ' + (on ? 'font-medium text-brand' : 'text-t3')}>
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 主体 */}
        <div className="px-5 py-5">
          {phase === 'steps' && step === 1 && <Step1 />}
          {phase === 'steps' && step === 2 && (
            <Step2 raw={raw} setRaw={setRaw} parsed={parsed} />
          )}
          {phase === 'steps' && step === 3 && (
            <Step3 parsed={parsed} picked={picked} onToggle={togglePick} onAll={(on) => setPicked(on ? okList.map((x) => x.i) : [])} />
          )}
          {phase === 'steps' && step === 4 && (
            <Step4
              unitFen={unitFen}
              count={pickedRows.length}
              totalFen={totalFen}
              balance={balance}
              shortFen={shortFen}
            />
          )}

          {(phase === 'processing' || phase === 'done') && (
            <Result rows={rows || []} doneN={doneN} failN={failN} phase={phase} />
          )}

          {err && (
            <div className="mt-4 rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{err}</div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4">
          {phase === 'steps' ? (
            <>
              <button
                type="button"
                onClick={() => (step === 1 ? close() : gotoStep(step - 1))}
                className="kc-btn kc-btn-ghost kc-btn-sm"
              >
                {step === 1 ? '取消' : '上一步'}
              </button>

              {step < 4 ? (
                <button type="button" onClick={next} className="kc-btn kc-btn-primary">
                  {step === 3 ? `下一步：确认订单（${pickedRows.length} 个） →` : '下一步 →'}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  {shortFen > 0 ? (
                    <Link href="/topup" className="kc-btn kc-btn-primary">
                      余额不足，去充值 →
                    </Link>
                  ) : (
                    <button type="button" onClick={pay} className="kc-btn kc-btn-primary">
                      确认支付 {formatUSD(totalFen)} →
                    </button>
                  )}
                </div>
              )}
            </>
          ) : phase === 'processing' ? (
            <>
              <span className="text-aux text-t3">处理中，请勿关闭页面…</span>
              <span className="text-aux text-t3">
                已完成 {doneN} / {(rows || []).length}
              </span>
            </>
          ) : (
            <>
              <button type="button" onClick={close} className="kc-btn kc-btn-ghost kc-btn-sm">
                完成
              </button>
              <div className="flex items-center gap-2">
                {failN > 0 && (
                  <Link href="/help#after-sales" className="kc-btn kc-btn-ghost kc-btn-sm">
                    查看售后说明
                  </Link>
                )}
                <Link href="/order" className="kc-btn kc-btn-primary kc-btn-sm">
                  查看我的订单 →
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ────────────── 各步骤 ────────────── */

function Step1() {
  return (
    <div>
      <h3 className="text-h3 text-t1">第 1 步 · 登录你的 ChatGPT 账号</h3>
      <p className="mt-2 text-body text-t2">
        请先在浏览器登录你要开通的 ChatGPT 账号。如果已经登录，可以直接进入下一步。
      </p>
      <ol className="mt-4 space-y-2 text-body text-t2">
        <li className="flex gap-2">
          <span className="text-t3">1.</span>
          <span>打开 ChatGPT 并完成登录（没有账号可先注册）</span>
        </li>
        <li className="flex gap-2">
          <span className="text-t3">2.</span>
          <span>确认登录成功后再回到这里</span>
        </li>
      </ol>
      <div className="mt-5 flex flex-wrap gap-2">
        <a
          href="https://chatgpt.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="kc-btn kc-btn-ghost kc-btn-sm"
        >
          打开 ChatGPT ↗
        </a>
        <Link href="/help#start" className="kc-btn kc-btn-ghost kc-btn-sm">
          查看办理流程
        </Link>
      </div>
      <p className="mt-4 rounded-md bg-brand-soft px-3 py-2.5 text-aux text-brand">
        我们不会索要你的账号密码 —— 下一步你只需粘贴一串登录凭据，全程由系统自动完成开通。
      </p>
    </div>
  );
}

function Step2({
  raw,
  setRaw,
  parsed,
}: {
  raw: string;
  setRaw: (v: string) => void;
  parsed: ParsedSession[];
}) {
  const bad = parsed.filter((x) => !x.ok);
  return (
    <div>
      <h3 className="text-h3 text-t1">第 2 步 · 获取登录凭据</h3>
      <p className="mt-2 text-body text-t2">
        在已登录 ChatGPT 的浏览器里打开下面的地址，把页面显示的<strong className="font-medium text-t1">全部内容</strong>复制过来粘贴。
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <a
          href="https://chatgpt.com/api/auth/session"
          target="_blank"
          rel="noopener noreferrer"
          className="kc-btn kc-btn-ghost kc-btn-sm"
        >
          打开凭据页面 ↗
        </a>
        <Link href="/help#credentials" className="kc-btn kc-btn-ghost kc-btn-sm">
          凭据准备说明
        </Link>
        <span className="text-aux text-t3">页面会显示一段以 {'{'} 开头的 JSON</span>
      </div>

      <label htmlFor="sessions" className="mt-5 mb-1.5 block text-aux font-medium text-t1">
        粘贴内容（多个账号请每行一个）
      </label>
      <textarea
        id="sessions"
        rows={7}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder='{"accessToken":"eyJhbGciOi...","user":{"email":"you@example.com"}}'
        className="kc-input resize-y font-mono text-aux"
        spellCheck={false}
      />

      {bad.length > 0 && (
        <div className="mt-3 rounded-md bg-warn/[.08] px-3 py-2.5 text-aux text-warn">
          有 {bad.length} 行无法解析：{bad.slice(0, 2).map((b) => b.reason).join('；')}
        </div>
      )}

      <p className="mt-3 text-aux text-t3">
        凭据仅用于本次开通，提交后即从页面清除，不会保存在我们这里。
      </p>
    </div>
  );
}

function Step3({
  parsed,
  picked,
  onToggle,
  onAll,
}: {
  parsed: ParsedSession[];
  picked: number[];
  onToggle: (i: number) => void;
  onAll: (on: boolean) => void;
}) {
  const okCount = parsed.filter((x) => x.ok).length;
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-h3 text-t1">
          第 3 步 · 选择要开通的账号
          <span className="ml-2 text-aux font-normal text-t3">
            已选 {picked.length} / {okCount}
          </span>
        </h3>
        <div className="flex gap-2">
          <button type="button" onClick={() => onAll(true)} className="text-aux text-brand hover:underline">
            全选
          </button>
          <button type="button" onClick={() => onAll(false)} className="text-aux text-t3 hover:underline">
            清空
          </button>
        </div>
      </div>

      <ul className="mt-4 max-h-72 space-y-2 overflow-y-auto">
        {parsed.map((p, i) => {
          const on = picked.indexOf(i) >= 0;
          return (
            <li key={i}>
              <label
                className={
                  'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ' +
                  (p.ok
                    ? on
                      ? 'border-brand bg-brand-soft'
                      : 'border-line hover:border-line-strong'
                    : 'border-line bg-page opacity-70')
                }
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!p.ok}
                  onChange={() => p.ok && onToggle(i)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#0d9488]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-t1">
                    {p.email || '(未取到邮箱)'}
                  </span>
                  <span className="mt-0.5 block text-aux text-t3">
                    {p.ok ? (
                      <>
                        套餐 {p.plan}
                        {p.accountTail && <> · 账号 …{p.accountTail}</>}
                        {p.exp > 0 && <> · 凭据 {new Date(p.exp * 1000).toLocaleDateString('zh-CN')} 过期</>}
                      </>
                    ) : (
                      <span className="text-err">{p.reason}</span>
                    )}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-aux text-t3">
        勾选后系统会为每个账号单独下单并开通，按数量计费。
      </p>
    </div>
  );
}

function Step4({
  unitFen,
  count,
  totalFen,
  balance,
  shortFen,
}: {
  unitFen: number;
  count: number;
  totalFen: number;
  balance: number | null;
  shortFen: number;
}) {
  return (
    <div>
      <h3 className="text-h3 text-t1">第 4 步 · 确认并支付</h3>

      <div className="mt-4 rounded-md border border-line p-4">
        <div className="flex items-center justify-between text-body">
          <span className="text-t3">单价</span>
          <span className="text-t1">{formatUSD(unitFen)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-body">
          <span className="text-t3">开通数量</span>
          <span className="text-t1">× {count}</span>
        </div>
        <div className="my-3 h-px bg-line" />
        <div className="flex items-center justify-between">
          <span className="text-body text-t3">应付合计</span>
          <span className="text-h2 text-brand">{formatUSD(totalFen)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-aux">
          <span className="text-t3">账户余额</span>
          <span className={shortFen > 0 ? 'text-err' : 'text-t1'}>
            {balance == null ? '读取中…' : formatUSD(balance)}
          </span>
        </div>
      </div>

      {shortFen > 0 ? (
        <div className="mt-4 rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">
          余额不足，还差 {formatUSD(shortFen)}。请先充值后支付。
        </div>
      ) : (
        <div className="mt-4 rounded-md bg-ok/[.08] px-3 py-2.5 text-aux text-ok">
          余额充足，支付后系统会自动为每个账号完成开通。
        </div>
      )}

      <p className="mt-3 text-aux text-t3">
        开通一般 3~5 分钟完成，期间请不要关闭页面。
      </p>
      <Link href="/help#payment" className="mt-3 inline-flex text-aux text-brand hover:underline">
        查看余额与订单说明 →
      </Link>
    </div>
  );
}

function Result({
  rows,
  doneN,
  failN,
  phase,
}: {
  rows: BatchRow[];
  doneN: number;
  failN: number;
  phase: Phase;
}) {
  return (
    <div>
      <h3 className="text-h3 text-t1">
        {phase === 'processing' ? '正在支付并开通…' : failN === 0 ? '全部开通完成' : `处理完成（成功 ${doneN} · 失败 ${failN}）`}
      </h3>
      <p className="mt-1 text-aux text-t3">
        {phase === 'processing'
          ? '请保持页面开启，完成后会自动显示结果。'
          : failN === 0
            ? '重新登录 ChatGPT 即可看到新订阅。'
            : '失败的账号已生成卡密，可到「我的订单」点「去开通」重新提交（重新提供凭据）。'}
      </p>

      {phase === 'done' && (
        <div className="mt-3 rounded-md border border-warn/25 bg-warn/[.07] px-3.5 py-2.5 text-aux text-t2">
          <div className="font-medium text-warn">卡密已保存在「我的订单」</div>
          <div className="mt-1">
            卡密等同于提货凭证，<strong className="font-medium text-t1">谁先兑换算谁的</strong>，
            请勿截图分享或转发——被他人兑换后平台无法追回。
          </div>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {rows.map((r, i) => (
          <li
            key={i}
            className={
              'rounded-md border p-3 ' +
              (r.state === 'done' ? 'border-ok/30 bg-ok/[.05]' : r.state === 'failed' ? 'border-err/30 bg-err/[.05]' : 'border-line')
            }
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 truncate text-body text-t1">{r.email || '(未取到邮箱)'}</span>
              <span className="shrink-0">
                {r.state === 'done' ? (
                  <span className="kc-tag kc-tag-ok">已完成</span>
                ) : r.state === 'failed' ? (
                  <span className="kc-tag kc-tag-err">失败</span>
                ) : (
                  <span className="kc-tag kc-tag-mute">{ROW_LABEL[r.state] || ''}</span>
                )}
              </span>
            </div>
            <div className="mt-1 text-aux text-t3">
              {r.msg}
              {r.tradeNo && <> · 订单 {String(r.tradeNo).slice(-8)}</>}
            </div>
            {r.state === 'opening' && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-brand transition-all duration-300"
                  style={{ width: Math.max(5, r.progress || 5) + '%' }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
