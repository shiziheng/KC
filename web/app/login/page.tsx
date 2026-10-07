'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';

type Tab = 'login' | 'register';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { login, register, loggedIn, loading } = useAuth();

  const [tab, setTab] = useState<Tab>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const redirect = params.get('redirect') || '/';

  useEffect(() => {
    if (!loading && loggedIn) router.replace(redirect);
  }, [loading, loggedIn, router, redirect]);

  const switchTab = (t: Tab) => {
    setTab(t);
    setErr('');
    setPassword('');
    setPassword2('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');

    if (!EMAIL_RE.test(email.trim())) {
      setErr('请输入正确的邮箱地址');
      return;
    }
    if (password.length < 8) {
      setErr('密码至少 8 位');
      return;
    }
    if (tab === 'register' && password !== password2) {
      setErr('两次输入的密码不一致');
      return;
    }

    setBusy(true);
    const r =
      tab === 'login'
        ? await login(email.trim(), password)
        : await register(email.trim(), password, inviteCode.trim() || undefined);
    setBusy(false);

    if (r.ok) router.replace(redirect);
    else setErr(r.message);
  };

  if (loading) {
    return <div className="kc-card mx-auto h-80 max-w-md animate-pulse" />;
  }

  return (
    <div className="kc-card mx-auto max-w-md p-6 md:p-8">
      <h1 className="text-h2 text-t1">{tab === 'login' ? '登录' : '注册新账号'}</h1>
      <p className="mt-1.5 text-aux text-t3">
        {tab === 'login' ? '登录后即可下单、查看订单与余额' : '注册即可开始使用，无需邮箱验证'}
      </p>

      <div className="mt-5 flex gap-1 rounded-md bg-page p-1">
        <button
          type="button"
          onClick={() => switchTab('login')}
          className={
            'flex-1 rounded-sm py-2 text-body font-medium transition-colors ' +
            (tab === 'login' ? 'bg-card text-brand shadow-sm' : 'text-t3 hover:text-t1')
          }
        >
          登录
        </button>
        <button
          type="button"
          onClick={() => switchTab('register')}
          className={
            'flex-1 rounded-sm py-2 text-body font-medium transition-colors ' +
            (tab === 'register' ? 'bg-card text-brand shadow-sm' : 'text-t3 hover:text-t1')
          }
        >
          注册
        </button>
      </div>

      <form onSubmit={submit} className="mt-5 space-y-4">
        <div>
          <label htmlFor="email" className="mb-1.5 block text-aux font-medium text-t1">
            邮箱
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            className="kc-input"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-1.5 block text-aux font-medium text-t1">
            密码
          </label>
          <input
            id="password"
            type="password"
            autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
            className="kc-input"
            placeholder="至少 8 位"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {tab === 'register' && (
          <>
            <div>
              <label htmlFor="password2" className="mb-1.5 block text-aux font-medium text-t1">
                确认密码
              </label>
              <input
                id="password2"
                type="password"
                autoComplete="new-password"
                className="kc-input"
                placeholder="再次输入密码"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                required
              />
            </div>

            {showInvite ? (
              <div>
                <label htmlFor="invite" className="mb-1.5 block text-aux font-medium text-t1">
                  邀请码<span className="ml-1 text-t3">（选填）</span>
                </label>
                <input
                  id="invite"
                  type="text"
                  className="kc-input"
                  placeholder="填写后双方均可获得返佣"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowInvite(true)}
                className="text-aux text-brand hover:underline"
              >
                + 我有邀请码
              </button>
            )}
          </>
        )}

        {err && <div className="rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{err}</div>}

        <button type="submit" disabled={busy} className="kc-btn kc-btn-primary w-full">
          {busy ? '处理中…' : tab === 'login' ? '登录' : '注册并登录'}
        </button>
      </form>

      {tab === 'login' && (
        <div className="mt-4 text-center">
          <Link href="/forgot" className="text-aux text-t3 hover:text-brand">
            忘记密码？
          </Link>
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="kc-container py-10 md:py-16">
      <Suspense fallback={<div className="kc-card mx-auto h-80 max-w-md animate-pulse" />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
