'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';

export default function ProfilePage() {
  const router = useRouter();
  const { user, loading, loggedIn, logout, changePassword } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !loggedIn) router.replace('/login?redirect=/profile');
  }, [loading, loggedIn, router]);

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword.length < 8) return setError('新密码至少 8 位');
    if (newPassword !== confirmPassword) return setError('两次输入的新密码不一致');
    setBusy(true);
    const result = await changePassword(oldPassword, newPassword);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    setSuccess('密码已修改');
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }

  if (loading || !user) return <div className="kc-container py-10"><div className="kc-card h-64 animate-pulse" /></div>;

  return (
    <div className="kc-container py-8 md:py-12">
      <h1 className="text-h1 text-t1">账户设置</h1>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <section className="kc-card p-5">
          <h2 className="text-h3 text-t1">登录账户</h2>
          <p className="mt-4 text-aux text-t3">邮箱</p><p className="mt-1 break-all text-body text-t1">{user.email}</p>
          <p className="mt-4 rounded-md bg-page px-3 py-2.5 text-aux text-t3">当前 Mock 订单与旧商城余额、充值流水及推广数据相互独立；此页面不会修改余额。</p>
          <div className="mt-5 flex flex-wrap gap-2"><Link href="/order" className="kc-btn kc-btn-ghost kc-btn-sm">我的模拟订单</Link><button type="button" onClick={() => { logout(); router.push('/'); }} className="kc-btn kc-btn-ghost kc-btn-sm text-err">退出登录</button></div>
        </section>
        <section className="kc-card p-5">
          <h2 className="text-h3 text-t1">修改登录密码</h2>
          <form onSubmit={(event) => void savePassword(event)} className="mt-4 space-y-3">
            <label className="block text-aux text-t2">当前密码<input type="password" autoComplete="current-password" className="kc-input mt-1.5 w-full" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} required /></label>
            <label className="block text-aux text-t2">新密码（至少 8 位）<input type="password" autoComplete="new-password" className="kc-input mt-1.5 w-full" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
            <label className="block text-aux text-t2">确认新密码<input type="password" autoComplete="new-password" className="kc-input mt-1.5 w-full" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
            {error && <div className="rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{error}</div>}
            {success && <div className="rounded-md bg-ok/[.08] px-3 py-2.5 text-aux text-ok">{success}</div>}
            <button type="submit" disabled={busy} className="kc-btn kc-btn-primary">{busy ? '提交中…' : '确认修改'}</button>
          </form>
        </section>
      </div>
    </div>
  );
}
