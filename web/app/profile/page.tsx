'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { formatUSD } from '@/lib/format';
import { fetchMyLedger } from '@/lib/ledger';
import type { LedgerEntry, LedgerReconciliation } from '@/lib/types';

export default function ProfilePage() {
  const router = useRouter();
  const { user, loading, loggedIn, logout, changePassword } = useAuth();

  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [pwdErr, setPwdErr] = useState('');
  const [pwdOk, setPwdOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [reconciliation, setReconciliation] = useState<LedgerReconciliation | null>(null);

  // 未登录跳登录页，回来时仍落到这里
  useEffect(() => {
    if (!loading && !loggedIn) router.replace('/login?redirect=/profile');
  }, [loading, loggedIn, router]);

  useEffect(() => {
    if (loading || !loggedIn) return;
    void fetchMyLedger().then((result) => {
      if (!result) return;
      setLedger(result.entries);
      setReconciliation(result.reconciliation);
    });
  }, [loading, loggedIn]);

  const submitPwd = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdErr('');
    setPwdOk('');

    if (!oldPwd) return setPwdErr('请输入当前密码');
    if (newPwd.length < 8) return setPwdErr('新密码至少 8 位');
    if (newPwd !== newPwd2) return setPwdErr('两次输入的新密码不一致');
    if (newPwd === oldPwd) return setPwdErr('新密码不能与当前密码相同');

    setBusy(true);
    const r = await changePassword(oldPwd, newPwd);
    setBusy(false);

    if (r.ok) {
      setPwdOk('密码已修改，下次请使用新密码登录');
      setOldPwd('');
      setNewPwd('');
      setNewPwd2('');
    } else {
      setPwdErr(r.message);
    }
  };

  if (loading || !user) {
    return (
      <div className="kc-container py-10">
        <div className="kc-card h-64 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="kc-container py-8 md:py-12">
      <h1 className="text-h1 text-t1">个人中心</h1>

      <div className="mt-6 grid gap-4 md:grid-cols-[1fr_1.2fr]">
        {/* 账户概览 */}
        <div className="kc-card p-5">
          <h2 className="text-h3 text-t1">账户信息</h2>

          <dl className="mt-4 space-y-3">
            <div>
              <dt className="text-aux text-t3">邮箱</dt>
              <dd className="mt-0.5 break-all text-body text-t1">{user.email}</dd>
            </div>
            <div>
              <dt className="text-aux text-t3">账户余额</dt>
              <dd className="mt-0.5 text-h2 text-brand">{formatUSD(user.balance)}</dd>
            </div>
            {user.commission_balance > 0 && (
              <div>
                <dt className="text-aux text-t3">推广佣金</dt>
                <dd className="mt-0.5 text-body text-t1">{formatUSD(user.commission_balance)}</dd>
              </div>
            )}
          </dl>

          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/topup" className="kc-btn kc-btn-primary kc-btn-sm">
              充值
            </Link>
            <Link href="/order" className="kc-btn kc-btn-ghost kc-btn-sm">
              我的订单
            </Link>
            <button
              type="button"
              onClick={() => {
                logout();
                router.push('/');
              }}
              className="kc-btn kc-btn-ghost kc-btn-sm text-err"
            >
              退出登录
            </button>
          </div>
        </div>

        {/* 余额流水（只读） */}
        <div className="kc-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-h3 text-t1">余额流水</h2>
            {reconciliation && (
              <span className={'kc-tag ' + (reconciliation.status === 'matched' ? 'kc-tag-ok' : 'kc-tag-warn')}>
                {reconciliation.status === 'matched' ? '已核对' : '待核对'}
              </span>
            )}
          </div>
          <p className="mt-1 text-aux text-t3">仅展示余额充值、订单扣款和失败补偿，不包含分销佣金流水。</p>
          {!ledger.length ? (
            <p className="mt-4 text-aux text-t3">暂时没有可展示的余额流水。</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {ledger.slice(0, 8).map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-body text-t1">{entry.type_cn}</div>
                    <div className="text-aux text-t3">{entry.trade_no ? '订单 ' + String(entry.trade_no).slice(-10) + ' · ' : ''}{formatLedgerTime(entry.created_at)}</div>
                  </div>
                  <div className={'shrink-0 text-body font-medium ' + (entry.amount >= 0 ? 'text-ok' : 'text-err')}>
                    {entry.amount >= 0 ? '+' : ''}{formatUSD(entry.amount)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 修改密码 */}
        <div className="kc-card p-5">
          <h2 className="text-h3 text-t1">修改密码</h2>
          <p className="mt-1 text-aux text-t3">修改后请使用新密码登录，其他设备上的登录状态可能需要重新登录。</p>

          <form onSubmit={submitPwd} className="mt-4 space-y-4">
            <div>
              <label htmlFor="oldPwd" className="mb-1.5 block text-aux font-medium text-t1">
                当前密码
              </label>
              <input
                id="oldPwd"
                type="password"
                autoComplete="current-password"
                className="kc-input"
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="newPwd" className="mb-1.5 block text-aux font-medium text-t1">
                新密码
              </label>
              <input
                id="newPwd"
                type="password"
                autoComplete="new-password"
                className="kc-input"
                placeholder="至少 8 位"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="newPwd2" className="mb-1.5 block text-aux font-medium text-t1">
                确认新密码
              </label>
              <input
                id="newPwd2"
                type="password"
                autoComplete="new-password"
                className="kc-input"
                value={newPwd2}
                onChange={(e) => setNewPwd2(e.target.value)}
                required
              />
            </div>

            {pwdErr && <div className="rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{pwdErr}</div>}
            {pwdOk && <div className="rounded-md bg-ok/[.08] px-3 py-2.5 text-aux text-ok">{pwdOk}</div>}

            <button type="submit" disabled={busy} className="kc-btn kc-btn-primary">
              {busy ? '提交中…' : '确认修改'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function formatLedgerTime(timestamp: number): string {
  if (!timestamp) return '';
  return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
}
