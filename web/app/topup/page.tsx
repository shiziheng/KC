'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { formatUSD } from '@/lib/format';
import {
  createTopupOrder,
  fetchPaymentMethods,
  fetchSubscribe,
  hasActiveSubscribe,
  MAX_USD,
  MIN_USD,
  PRESET_USD,
  waitForPayment,
  type PayOutcome,
} from '@/lib/topup';
import type { PaymentMethod, Subscribe } from '@/lib/types';

type Phase = 'loading' | 'blocked' | 'amount' | 'pay' | 'waiting' | 'done';

export default function TopupPage() {
  const { user, loading: authLoading, loggedIn, refresh } = useAuth();

  const [phase, setPhase] = useState<Phase>('loading');
  const [sub, setSub] = useState<Subscribe | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [methodId, setMethodId] = useState<number | null>(null);
  const [amountUsd, setAmountUsd] = useState<number>(PRESET_USD[0]);
  const [custom, setCustom] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [tradeNo, setTradeNo] = useState('');
  const [payData, setPayData] = useState('');
  const [ticks, setTicks] = useState(0);
  const [outcome, setOutcome] = useState<PayOutcome | null>(null);

  const stoppedRef = useRef(false);
  // ⚠️ 必须在 effect 里**重置**为 false：
  //    React StrictMode（开发模式）会「挂载 → 卸载 → 再挂载」，
  //    如果只在卸载时置 true，重新挂载后就永远是 true，
  //    导致支付轮询第一次判断就认为「组件已卸载」而立即放弃。
  useEffect(() => {
    stoppedRef.current = false;
    return () => { stoppedRef.current = true; };
  }, []);

  /* 初始化：检查登录 → 检查订阅 → 拉支付方式 */
  useEffect(() => {
    if (authLoading) return;
    if (!loggedIn) { setPhase('loading'); return; }

    let alive = true;
    (async () => {
      const s = await fetchSubscribe();
      if (!alive) return;
      setSub(s);

      // 防套利：已有有效订阅不允许充值余额
      if (hasActiveSubscribe(s)) { setPhase('blocked'); return; }

      const ms = await fetchPaymentMethods();
      if (!alive) return;
      setMethods(ms);
      setMethodId(ms.length ? ms[0].id : null);
      setPhase('amount');
    })();

    return () => { alive = false; };
  }, [authLoading, loggedIn]);

  const finalUsd = useCustom ? Number(custom) : amountUsd;
  const validAmount = Number.isFinite(finalUsd) && finalUsd >= MIN_USD && finalUsd <= MAX_USD && finalUsd % 1 === 0;

  /* 支付 */
  const pay = useCallback(async () => {
    if (!validAmount || !methodId) return;
    setErr('');
    setBusy(true);

    const r = await createTopupOrder(finalUsd * 100, methodId);
    setBusy(false);

    if (!r.ok) { setErr(r.message); return; }

    setTradeNo(r.tradeNo);
    setPayData(r.data);
    setPhase('waiting');

    // 收银台：新窗打开（BEpusdt 收银台是 URL）
    if (r.data && /^https?:\/\//i.test(r.data)) {
      try { window.open(r.data, '_blank', 'noopener'); } catch { window.location.href = r.data; }
    }

    const oc = await waitForPayment(r.tradeNo, (n) => setTicks(n), () => stoppedRef.current);
    setOutcome(oc);
    setPhase('done');
    void refresh();
  }, [validAmount, methodId, finalUsd, refresh]);

  /* 手动刷新一次 */
  const recheck = useCallback(async () => {
    if (!tradeNo) return;
    setBusy(true);
    const oc = await waitForPayment(tradeNo, (n) => setTicks(n), () => true);
    setBusy(false);
    setOutcome(oc);
    setPhase('done');
    void refresh();
  }, [tradeNo, refresh]);

  /* ── 未登录 ── */
  if (!authLoading && !loggedIn) {
    return (
      <div className="kc-container py-12">
        <div className="kc-card mx-auto max-w-md p-8 text-center">
          <h1 className="text-h2 text-t1">充值需要先登录</h1>
          <p className="mt-2 text-body text-t2">登录后即可为账户充值余额。</p>
          <Link href="/login?redirect=/topup" className="kc-btn kc-btn-primary mt-5">
            登录 / 注册
          </Link>
        </div>
      </div>
    );
  }

  /* ── 有有效订阅：拦截 ── */
  if (phase === 'blocked') {
    const expText = sub?.expired_at ? new Date(sub.expired_at * 1000).toLocaleDateString('zh-CN') : '';
    return (
      <div className="kc-container py-12">
        <div className="kc-card mx-auto max-w-lg p-8 text-center">
          <div className="text-h1">✓</div>
          <h1 className="mt-3 text-h2 text-t1">
            你已有有效订阅
            {expText && (
              <span className="ml-1 text-aux font-normal text-t3">
                （{sub?.plan?.name || '当前套餐'} · {expText} 到期）
              </span>
            )}
          </h1>
          <p className="mt-3 text-body text-t2">
            无需充值余额 —— 购买其他套餐时可直接下单，支付时用 USDT 一步完成。
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <Link href="/plan" className="kc-btn kc-btn-primary">
              去看看其他套餐
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="kc-container py-8 md:py-12">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1 text-t1">余额充值</h1>
          <p className="mt-1.5 text-body text-t2">充值后可用于购买商品，下单时自动抵扣。</p>
        </div>
        <div className="text-right">
          <div className="text-aux text-t3">当前余额</div>
          <div className="text-h2 text-brand">{user ? formatUSD(user.balance) : '—'}</div>
        </div>
      </header>

      <div className="mt-6 grid gap-4 md:grid-cols-[1.1fr_1fr]">
        {/* 左：金额与支付方式 */}
        <div className="kc-card p-5">
          {phase === 'loading' && <div className="h-64 animate-pulse rounded-md bg-page" />}

          {(phase === 'amount' || phase === 'pay') && (
            <>
              <h2 className="text-h3 text-t1">选择金额</h2>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {PRESET_USD.map((v) => {
                  const on = !useCustom && amountUsd === v;
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => { setUseCustom(false); setAmountUsd(v); }}
                      className={
                        'rounded-md border py-2.5 text-body font-medium transition-colors ' +
                        (on ? 'border-brand bg-brand-soft text-brand' : 'border-line text-t1 hover:border-line-strong')
                      }
                    >
                      ${v}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3">
                <label className="mb-1.5 block text-aux text-t3">
                  或自定义金额（整数美元，{MIN_USD}~{MAX_USD}）
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-body font-medium text-t1">$</span>
                  <input
                    type="number"
                    min={MIN_USD}
                    max={MAX_USD}
                    step={1}
                    placeholder="如 20"
                    value={custom}
                    onChange={(e) => { setCustom(e.target.value); setUseCustom(true); }}
                    onFocus={() => setUseCustom(true)}
                    className="kc-input"
                  />
                </div>
              </div>

              {methods.length > 0 ? (
                <>
                  <h2 className="mt-6 text-h3 text-t1">支付方式</h2>
                  <div className="mt-3 space-y-2">
                    {methods.map((m) => (
                      <label
                        key={m.id}
                        className={
                          'flex cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors ' +
                          (methodId === m.id ? 'border-brand bg-brand-soft' : 'border-line hover:border-line-strong')
                        }
                      >
                        <input
                          type="radio"
                          name="pay"
                          checked={methodId === m.id}
                          onChange={() => setMethodId(m.id)}
                          className="h-4 w-4 accent-[#0d9488]"
                        />
                        <span className="flex-1 text-body text-t1">{m.name}</span>
                        {(Number(m.handling_fee_fixed) > 0 || Number(m.handling_fee_percent) > 0) && (
                          <span className="text-aux text-warn">含手续费</span>
                        )}
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <div className="mt-6 rounded-md bg-warn/[.08] px-3 py-2.5 text-aux text-warn">
                  本站暂未配置在线支付渠道，请联系客服。
                </div>
              )}

              {err && <div className="mt-4 rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{err}</div>}

              <button
                type="button"
                disabled={!validAmount || !methodId || busy || methods.length === 0}
                onClick={pay}
                className="kc-btn kc-btn-primary mt-5 w-full"
              >
                {busy ? '创建订单中…' : `确认支付 ${validAmount ? formatUSD(finalUsd * 100) : ''}`}
              </button>
              {!validAmount && (
                <p className="mt-2 text-center text-aux text-t3">
                  请输入 {MIN_USD}~{MAX_USD} 之间的整数金额
                </p>
              )}
            </>
          )}

          {phase === 'waiting' && (
            <>
              <h2 className="text-h3 text-t1">等待支付</h2>
              <p className="mt-2 text-body text-t2">
                已为你打开支付页面。完成付款后本页会自动更新，无需手动刷新。
              </p>
              <div className="mt-4 rounded-md border border-line p-4">
                <div className="flex justify-between text-aux">
                  <span className="text-t3">订单号</span>
                  <span className="font-mono text-t1">{tradeNo}</span>
                </div>
                <div className="mt-2 flex justify-between text-aux">
                  <span className="text-t3">应付金额</span>
                  <span className="text-t1">{formatUSD(finalUsd * 100)}</span>
                </div>
                <div className="mt-2 flex justify-between text-aux">
                  <span className="text-t3">状态</span>
                  <span className="text-warn">等待支付确认…（{ticks}）</span>
                </div>
              </div>

              {payData && /^https?:\/\//i.test(payData) && (
                <a href={payData} target="_blank" rel="noopener noreferrer" className="kc-btn kc-btn-ghost mt-4 w-full">
                  重新打开支付页面 ↗
                </a>
              )}

              <button type="button" onClick={recheck} disabled={busy} className="kc-btn kc-btn-ghost mt-3 w-full">
                {busy ? '查询中…' : '我已完成支付，立即查询'}
              </button>
            </>
          )}

          {phase === 'done' && outcome && (
            <>
              {outcome.status === 'done' ? (
                <>
                  <div className="text-center">
                    <div className="text-h1 text-ok">✓</div>
                    <h2 className="mt-3 text-h2 text-t1">充值成功</h2>
                    <p className="mt-2 text-body text-t2">
                      {outcome.amount > 0 ? formatUSD(outcome.amount) + ' 已到账' : '余额已到账'}
                      {outcome.balanceAfter > 0 && <>，当前余额 {formatUSD(outcome.balanceAfter)}</>}
                    </p>
                  </div>
                  <div className="mt-6 flex justify-center gap-2">
                    <Link href="/plan" className="kc-btn kc-btn-primary">
                      去购买商品
                    </Link>
                    <Link href="/order" className="kc-btn kc-btn-ghost">
                      查看充值记录
                    </Link>
                  </div>
                </>
              ) : outcome.status === 'cancelled' ? (
                <>
                  <h2 className="text-h3 text-err">订单已取消</h2>
                  <p className="mt-2 text-body text-t2">该订单已被取消。如你已付款，请联系客服处理。</p>
                  <div className="mt-5 flex gap-2">
                    <button type="button" onClick={() => { setPhase('amount'); setErr(''); }} className="kc-btn kc-btn-primary">
                      重新充值
                    </button>
                    <Link href="/order" className="kc-btn kc-btn-ghost">
                      查看订单
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="text-h3 text-warn">尚未收到付款</h2>
                  <p className="mt-2 text-body text-t2">
                    如果在别处已完成支付，点下方按钮再查一次；充值记录可在「我的订单」查看。
                  </p>
                  <div className="mt-5 flex gap-2">
                    <button type="button" onClick={recheck} disabled={busy} className="kc-btn kc-btn-primary">
                      {busy ? '查询中…' : '再查一次'}
                    </button>
                    <Link href="/order" className="kc-btn kc-btn-ghost">
                      查看订单
                    </Link>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* 右：说明 */}
        <div className="kc-card h-fit p-5">
          <h2 className="text-h3 text-t1">说明</h2>
          <ul className="mt-3 space-y-2.5 text-body text-t2">
            <li className="flex gap-2"><span className="text-brand">·</span><span>充值到账后可用于购买任意商品，下单时自动抵扣。</span></li>
            <li className="flex gap-2"><span className="text-brand">·</span><span>支持 USDT（TRC20）付款，链上确认一般需要几分钟。</span></li>
            <li className="flex gap-2"><span className="text-brand">·</span><span>充值订单 <strong className="font-medium text-t1">30 分钟</strong>内有效，超时未付会自动失效，可重新发起。</span></li>
            <li className="flex gap-2"><span className="text-brand">·</span><span>余额仅用于本平台消费，不支持提现。</span></li>
          </ul>

          <div className="mt-5 border-t border-line pt-4">
            <Link href="/order" className="text-body text-brand hover:underline">
              查看充值记录 →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
