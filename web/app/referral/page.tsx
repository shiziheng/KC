'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { formatUSD } from '@/lib/format';

type InviteData = {
  codes: { id: number; code: string }[];
  stat: number[];
};

/** 三级分销比例（与后台 commission_distribution_l1/l2/l3 配置一致，改动需同步） */
const RATES = [
  { level: '一级', pct: 20, desc: '你直接邀请的好友' },
  { level: '二级', pct: 10, desc: '好友再邀请的人' },
  { level: '三级', pct: 5, desc: '好友的好友再邀请的人' },
];

export default function ReferralPage() {
  const { loggedIn, loading: authLoading, user } = useAuth();

  const [data, setData] = useState<InviteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [genBusy, setGenBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!loggedIn) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/xb/v1/user/invite/fetch', {
        headers: { Accept: 'application/json', Authorization: localStorage.getItem('kc_token') || '' },
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.status === 'success') setData(j.data);
    } catch { /* 忽略，页面仍可显示规则 */ }
    setLoading(false);
  }, [loggedIn]);

  useEffect(() => {
    if (!authLoading) void load();
  }, [authLoading, load]);

  const code = data?.codes?.[0]?.code || '';

  const inviteLink = code && typeof window !== 'undefined'
    ? `${window.location.origin}/#/login?invite_code=${encodeURIComponent(code)}`
    : '';

  const genCode = useCallback(async () => {
    setGenBusy(true);
    setErr('');
    try {
      // Xboard 的 invite/save 是 GET 路由（POST 会 405）
      const res = await fetch('/api/xb/v1/user/invite/save', {
        headers: { Accept: 'application/json', Authorization: localStorage.getItem('kc_token') || '' },
      });
      const j = await res.json().catch(() => ({}));
      if (!(res.ok && j.status === 'success')) {
        setErr(j.message || '生成失败，请稍后重试');
      }
    } catch { setErr('网络异常，请稍后重试'); }
    await load();
    setGenBusy(false);
  }, [load]);

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(''), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className="kc-container py-8 md:py-12">
      <header>
        <h1 className="text-h1 text-t1">邀请返利</h1>
        <p className="mt-1.5 text-body text-t2">
          邀请好友购买商品，可获得订单金额一定比例的返利，自动发放到你的账户余额。
        </p>
      </header>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {/* ── 我的邀请信息 ── */}
        <div className="kc-card p-5">
          <h2 className="text-h3 text-t1">我的邀请</h2>

          {authLoading || loading ? (
            <div className="mt-4 h-32 animate-pulse rounded-md bg-page" />
          ) : !loggedIn ? (
            <>
              <p className="mt-3 text-body text-t2">登录后即可获取你的专属邀请码与链接。</p>
              <Link href="/login?redirect=/referral" className="kc-btn kc-btn-primary mt-4">
                登录 / 注册
              </Link>
            </>
          ) : code ? (
            <>
              <div className="mt-4">
                <div className="text-aux text-t3">邀请码</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="font-mono text-body font-medium text-t1">{code}</span>
                  <button
                    type="button"
                    onClick={() => void copy(code, 'code')}
                    className="text-aux text-brand hover:underline"
                  >
                    {copied === 'code' ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
              <div className="mt-4">
                <div className="text-aux text-t3">邀请链接</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-aux text-t2">{inviteLink}</span>
                  <button
                    type="button"
                    onClick={() => void copy(inviteLink, 'link')}
                    className="shrink-0 text-aux text-brand hover:underline"
                  >
                    {copied === 'link' ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
              {err && <div className="mt-3 text-aux text-err">{err}</div>}
            </>
          ) : (
            <>
              <p className="mt-3 text-body text-t2">你还没有邀请码，生成一个即可开始邀请。</p>
              {err && <div className="mt-3 text-aux text-err">{err}</div>}
              <button type="button" disabled={genBusy} onClick={() => void genCode()} className="kc-btn kc-btn-primary mt-4">
                {genBusy ? '生成中…' : '生成我的邀请码'}
              </button>
            </>
          )}
        </div>

        {/* ── 返利规则 ── */}
        <div className="kc-card p-5">
          <h2 className="text-h3 text-t1">返利规则</h2>

          <div className="mt-4 space-y-3">
            {RATES.map((r) => (
              <div key={r.level} className="flex items-center justify-between rounded-md border border-line px-3.5 py-3">
                <div>
                  <div className="text-body font-medium text-t1">{r.level}返利 {r.pct}%</div>
                  <div className="mt-0.5 text-aux text-t3">{r.desc}</div>
                </div>
                <span className="text-h3 text-brand">{r.pct}%</span>
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-2.5 text-aux text-t2">
            <div className="flex gap-2">
              <span className="text-brand">·</span>
              <span>返利发放到<strong className="font-medium text-t1">账户余额</strong>，可直接用于购买商品；<strong className="font-medium text-t1">不支持提现</strong>。</span>
            </div>
            <div className="flex gap-2">
              <span className="text-brand">·</span>
              <span>被邀请人的订单<strong className="font-medium text-t1">完成后满 3 天</strong>自动结算（留出处理纠纷的时间）。</span>
            </div>
            <div className="flex gap-2">
              <span className="text-brand">·</span>
              <span>返利按订单<strong className="font-medium text-t1">实际在线支付金额</strong>计算；使用余额抵扣的部分不计入。</span>
            </div>
            <div className="flex gap-2">
              <span className="text-brand">·</span>
              <span>购买<strong className="font-medium text-t1">余额充值</strong>不产生返利。</span>
            </div>
            <div className="flex gap-2">
              <span className="text-brand">·</span>
              <span>代充<strong className="font-medium text-t1">开通成功</strong>后才结算；开通失败的订单不产生返利。</span>
            </div>
          </div>
        </div>
      </div>

      {/* 常见疑问 */}
      <section className="mt-8">
        <h2 className="text-h2 text-t1">常见疑问</h2>
        <div className="mt-4 space-y-2">
          <div className="kc-card p-4">
            <div className="text-body font-medium text-t1">返利什么时候到账？</div>
            <p className="mt-1 text-aux text-t2">
              被邀请人的订单完成并<strong className="font-medium text-t1">开通成功</strong>后，满 3 天自动结算到你的账户余额。余额可直接用于购买商品。
            </p>
          </div>
          <div className="kc-card p-4">
            <div className="text-body font-medium text-t1">好友用余额购买，我有返利吗？</div>
            <p className="mt-1 text-aux text-t2">
              没有。返利按好友<strong className="font-medium text-t1">实际在线支付</strong>的金额计算（USDT 支付的部分），
              余额抵扣的部分不计入——这样可以避免「充值 + 消费」路径的返利被无限放大。
            </p>
          </div>
          <div className="kc-card p-4">
            <div className="text-body font-medium text-t1">返利可以提现吗？</div>
            <p className="mt-1 text-aux text-t2">
              不可以。返利发放到账户余额，只能用于本平台消费。这是为了保持平台资金合规，请知悉后再推广。
            </p>
          </div>
        </div>
      </section>

      <div className="mt-8 rounded-md bg-page px-4 py-3.5 text-aux text-t3">
        返利机制为推广激励性质，平台保留对异常订单（刷单、自买自邀等）不予结算的权利。
      </div>
    </div>
  );
}
