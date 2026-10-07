'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { parseSessionLine } from '@/lib/session';
import { pollRedeem, startRedeem, verifyCdk, type RedeemProgress } from '@/lib/redeem';

type Step = 1 | 2 | 3;

function RedeemForm() {
  const params = useSearchParams();

  const [step, setStep] = useState<Step>(1);
  const [cdk, setCdk] = useState('');
  const [planLabel, setPlanLabel] = useState('');
  const [session, setSession] = useState('');
  const [parsedEmail, setParsedEmail] = useState('');
  const [sessionConfirmed, setSessionConfirmed] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<RedeemProgress>({ done: false, progress: 0, message: '', error: '', state: 'processing', statusLabel: '开通中', nextAction: 'wait' });
  const [finished, setFinished] = useState(false);

  const stoppedRef = useRef(false);
  useEffect(() => {
    stoppedRef.current = false;
    return () => { stoppedRef.current = true; };
  }, []);

  // URL 预填（从订单页跳转过来时带 ?cdk=xxx）
  useEffect(() => {
    const c = params.get('cdk');
    if (c) setCdk(c.trim());
  }, [params]);

  // 若带 cdk 参数，自动验证一次
  const autoTried = useRef(false);
  useEffect(() => {
    const c = params.get('cdk');
    if (c && !autoTried.current) {
      autoTried.current = true;
      void doVerify(c.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function doVerify(code: string) {
    setErr('');
    if (!code) { setErr('请输入卡密'); return; }
    setBusy(true);
    const r = await verifyCdk(code);
    setBusy(false);
    if (!r.ok) {
      setErr(r.message);
      setProg({
        done: r.state === 'completed', progress: r.state === 'completed' ? 100 : 0,
        message: r.message, error: r.state === 'completed' ? '' : r.message,
        state: r.state, statusLabel: r.statusLabel, nextAction: r.nextAction,
      });
      setStep(3);
      setFinished(true);
      return;
    }

    setCdk(code);
    setPlanLabel(r.planLabel);

    // 已完成/已使用/已冻结/已过期等终态不再要求用户粘贴凭据，也不提供无限重试入口。
    if (r.state !== 'available' && r.state !== 'processing') {
      setProg({
        done: r.state === 'completed', progress: r.state === 'completed' ? 100 : 0,
        message: r.message || r.statusLabel, error: r.state === 'completed' ? '' : (r.message || r.statusLabel),
        state: r.state, statusLabel: r.statusLabel, nextAction: r.nextAction,
      });
      setStep(3);
      setFinished(true);
      return;
    }

    if (r.processing) {
      // 这张卡已在开通中 → 直接看进度，不必再要凭据
      setStep(3);
      setFinished(false);
      void runPoll(code);
      return;
    }
    setStep(2);
  }

  async function runPoll(code: string) {
    const final = await pollRedeem(
      code,
      (p) => { setProg(p); if (p.error || p.done) setFinished(true); },
      () => stoppedRef.current
    );
    setProg(final);
    setFinished(true);
  }

  async function doStart() {
    setErr('');
    const s = session.trim();
    if (s.length < 20) { setErr('凭据看起来不完整，请重新复制粘贴'); return; }
    if (!sessionConfirmed) { setErr('请先勾选确认开通账号无误'); return; }

    setBusy(true);
    const r = await startRedeem(cdk, s);
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }

    // 提交后立刻从内存里清掉凭据（不再需要）
    setSession('');
    setStep(3);
    setFinished(false);
    void runPoll(cdk);
  }

  /* 粘贴后解析出账号，供用户确认没粘错；内容变化需重新勾选确认 */
  function onSessionChange(v: string) {
    setSession(v);
    const p = parseSessionLine(v.trim());
    setParsedEmail(p.ok ? p.email : '');
    setSessionConfirmed(false);
  }

  return (
    <div className="kc-container py-8 md:py-12">
      <header className="mx-auto max-w-2xl">
        <h1 className="text-h1 text-t1">兑换卡密</h1>
        <p className="mt-1.5 text-body text-t2">
          输入卡密并粘贴你的 ChatGPT 账号凭据，系统会自动完成开通。
        </p>
      </header>

      {/* 步骤条 */}
      <div className="mx-auto mt-6 flex max-w-2xl gap-1">
        {['输入卡密', '提供凭据', '开通进度'].map((label, i) => {
          const idx = (i + 1) as Step;
          const on = idx === step;
          const done = idx < step;
          return (
            <div key={label} className="flex flex-1 items-center gap-2 px-1 py-1.5">
              <span
                className={
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-aux font-medium ' +
                  (on || done ? 'border-brand bg-brand text-white' : 'border-line text-t3')
                }
              >
                {done ? '✓' : idx}
              </span>
              <span className={'hidden text-aux sm:block ' + (on ? 'font-medium text-brand' : 'text-t3')}>{label}</span>
            </div>
          );
        })}
      </div>

      {/* ⚠️ 卡密风险前置告知（决策：保持非实名，但必须说清） */}
      <div className="mx-auto mt-4 max-w-2xl rounded-md border border-warn/25 bg-warn/[.07] px-3.5 py-3">
        <div className="text-aux font-medium text-warn">卡密等同于提货凭证，谁先兑换算谁的</div>
        <ul className="mt-1.5 space-y-1 text-aux text-t2">
          <li>· 这不是平台的规定，是卡密本身的工作原理——它不绑定账号，认码不认人</li>
          <li>· <strong className="font-medium text-t1">请勿截图分享或转发给他人</strong>；一旦被他人先兑换，平台无法追回</li>
          <li>· 建议购买后尽快兑换，避免长期存放</li>
        </ul>
      </div>

      <div className="kc-card mx-auto mt-4 max-w-2xl p-6 md:p-8">
        {/* ── 步骤 1 ── */}
        {step === 1 && (
          <>
            <h2 className="text-h3 text-t1">输入卡密</h2>
            <p className="mt-1.5 text-aux text-t3">卡密形如 KC-XXXXXX，购买后可在「我的订单」查看。</p>
            <input
              type="text"
              maxLength={64}
              value={cdk}
              onChange={(e) => setCdk(e.target.value)}
              placeholder="KC-XXXXXX"
              spellCheck={false}
              className="kc-input mt-4 font-mono tracking-wide"
              onKeyDown={(e) => { if (e.key === 'Enter') void doVerify(cdk.trim()); }}
            />
            {err && <div className="mt-3 rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{err}</div>}
            <button
              type="button"
              disabled={busy || !cdk.trim()}
              onClick={() => void doVerify(cdk.trim())}
              className="kc-btn kc-btn-primary mt-4 w-full"
            >
              {busy ? '验证中…' : '验证卡密'}
            </button>
          </>
        )}

        {/* ── 步骤 2 ── */}
        {step === 2 && (
          <>
            <h2 className="text-h3 text-t1">提供 ChatGPT 凭据</h2>
            <p className="mt-2 text-body text-t2">
              卡密验证通过{planLabel && <>：<strong className="font-medium text-t1">{planLabel}</strong></>}。
              请粘贴你要开通的账号凭据。
            </p>

            <div className="mt-4 rounded-md bg-page p-3.5 text-aux text-t2">
              <div className="font-medium text-t1">获取方式</div>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4">
                <li>在浏览器里登录 <span className="font-medium text-t1">chatgpt.com</span></li>
                <li>新标签页打开 <span className="font-mono text-t1">chatgpt.com/api/auth/session</span></li>
                <li>把页面显示的整段 JSON 复制粘贴到下面</li>
              </ol>
              <a
                href="https://chatgpt.com/api/auth/session"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-brand hover:underline"
              >
                打开凭据页面 ↗
              </a>
            </div>

            <textarea
              rows={7}
              value={session}
              onChange={(e) => onSessionChange(e.target.value)}
              placeholder='{"accessToken":"eyJhbGciOi...","user":{"email":"you@example.com"}}'
              spellCheck={false}
              className="kc-input mt-3 resize-y font-mono text-aux"
            />

            {parsedEmail && (
              <div className="mt-3 rounded-md bg-ok/[.08] px-3 py-2.5 text-aux text-ok">
                已识别账号：{parsedEmail}
              </div>
            )}

            {/* 二次确认：兑错账号不可逆，必须显式勾选 */}
            <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-page px-3 py-2.5">
              <input
                type="checkbox"
                checked={sessionConfirmed}
                onChange={(e) => setSessionConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#0d9488]"
              />
              <span className="text-aux text-t2">
                我确认凭据对应的是<strong className="font-medium text-t1">我自己的账号</strong>，
                开通权益将落到该账号。<span className="text-t3">（开通成功后不可更改或撤销）</span>
              </span>
            </label>

            {err && <div className="mt-3 rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{err}</div>}

            <div className="mt-4 flex items-center justify-between gap-2">
              <button type="button" onClick={() => { setStep(1); setErr(''); setSessionConfirmed(false); }} className="kc-btn kc-btn-ghost kc-btn-sm">
                上一步
              </button>
              <button type="button" disabled={busy || !sessionConfirmed} onClick={doStart} className="kc-btn kc-btn-primary">
                {busy ? '提交中…' : '开始开通'}
              </button>
            </div>

            <p className="mt-3 text-aux text-t3">
              凭据仅用于本次开通，提交后即从页面清除，不会保存。
            </p>
          </>
        )}

        {/* ── 步骤 3 ── */}
        {step === 3 && (
          <>
            {!finished ? (
              <>
                <h2 className="text-h3 text-t1">正在开通…</h2>
                <p className="mt-1.5 text-aux text-t3">一般 3~5 分钟完成，请保持页面开启。</p>

                <div className="mt-5 h-2 overflow-hidden rounded-full bg-page">
                  <div
                    className="h-full rounded-full bg-brand transition-all duration-500"
                    style={{ width: Math.max(5, Math.min(99, prog.progress || 5)) + '%' }}
                  />
                </div>
                <div className="mt-2 flex justify-between text-aux">
                    <span className="text-t2">{prog.message || prog.statusLabel || '开通处理中…'}</span>
                  <span className="text-t3">{prog.progress ? prog.progress + '%' : ''}</span>
                </div>

                <div className="mt-4 rounded-md bg-page px-3 py-2.5 text-aux text-t3">
                  卡密 <span className="font-mono">{cdk}</span> · 请勿关闭本页
                </div>
              </>
            ) : prog.done ? (
              <>
                <div className="text-center">
                  <div className="text-h1 text-ok">✓</div>
                  <h2 className="mt-3 text-h2 text-t1">开通完成</h2>
                  <p className="mt-2 text-body text-t2">
                    重新登录 ChatGPT 即可看到新的订阅。
                  </p>
                </div>
                <div className="mt-6 flex justify-center gap-2">
                  <Link href="/order" className="kc-btn kc-btn-primary">
                    查看我的订单
                  </Link>
                  <button type="button" onClick={() => { setStep(1); setCdk(''); setProg({ done: false, progress: 0, message: '', error: '', state: 'processing', statusLabel: '开通中', nextAction: 'wait' }); setFinished(false); }} className="kc-btn kc-btn-ghost">
                    再兑一张
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-h3 text-err">{prog.statusLabel || '开通未成功'}</h2>
                <p className="mt-2 text-body text-t2">{prog.error || prog.message || '开通失败，请联系客服。'}</p>
                <div className="mt-4 rounded-md bg-page px-3 py-2.5 text-aux text-t3">
                  卡密 <span className="font-mono">{cdk}</span>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  {prog.nextAction === 'provide_credentials' && (
                    <button
                      type="button"
                      onClick={() => { setStep(2); setErr(''); }}
                      className="kc-btn kc-btn-primary"
                    >
                      提供凭据
                    </button>
                  )}
                  {(prog.nextAction === 'view_order' || prog.state === 'used') && (
                    <Link href="/order" className="kc-btn kc-btn-primary">查看订单</Link>
                  )}
                  <Link href="/help#after-sales" className="kc-btn kc-btn-ghost">
                    查看售后说明
                  </Link>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function RedeemPage() {
  return (
    <Suspense fallback={<div className="kc-container py-12"><div className="kc-card mx-auto h-64 max-w-2xl animate-pulse" /></div>}>
      <RedeemForm />
    </Suspense>
  );
}
