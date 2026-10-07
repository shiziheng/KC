'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPage() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startCountdown = () => {
    setCountdown(60);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((v) => {
        if (v <= 1 && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return v - 1;
      });
    }, 1000);
  };

  const sendCode = async () => {
    setErr('');
    setOk('');
    if (!EMAIL_RE.test(email.trim())) {
      setErr('请先输入正确的邮箱地址');
      return;
    }
    setSending(true);
    const res = await api.post('/v1/passport/comm/sendEmailVerify', { email: email.trim() }, { auth: false });
    setSending(false);
    if (res.ok) {
      setOk('验证码已发送，请查收邮件（含垃圾箱）');
      startCountdown();
    } else {
      setErr(res.message || '验证码发送失败，请稍后重试');
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setOk('');

    if (!EMAIL_RE.test(email.trim())) return setErr('请输入正确的邮箱地址');
    if (!code.trim()) return setErr('请输入邮箱验证码');
    if (password.length < 8) return setErr('新密码至少 8 位');
    if (password !== password2) return setErr('两次输入的密码不一致');

    setBusy(true);
    const res = await api.post(
      '/v1/passport/auth/forget',
      { email: email.trim(), password, email_code: code.trim() },
      { auth: false }
    );
    setBusy(false);

    if (res.ok) {
      setOk('密码已重置，正在跳转到登录页…');
      setTimeout(() => router.replace('/login'), 1200);
    } else {
      setErr(res.message || '重置失败，请检查验证码是否正确');
    }
  };

  return (
    <div className="kc-container py-10 md:py-16">
      <div className="kc-card mx-auto max-w-md p-6 md:p-8">
        <h1 className="text-h2 text-t1">重置密码</h1>
        <p className="mt-1.5 text-aux text-t3">通过邮箱验证码重置你的登录密码。</p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-aux font-medium text-t1">
              邮箱
            </label>
            <div className="flex gap-2">
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
              <button
                type="button"
                onClick={sendCode}
                disabled={sending || countdown > 0}
                className="kc-btn kc-btn-ghost shrink-0 whitespace-nowrap"
              >
                {sending ? '发送中…' : countdown > 0 ? countdown + 's' : '获取验证码'}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="code" className="mb-1.5 block text-aux font-medium text-t1">
              邮箱验证码
            </label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              className="kc-input"
              placeholder="邮件中的验证码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-aux font-medium text-t1">
              新密码
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              className="kc-input"
              placeholder="至少 8 位"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="password2" className="mb-1.5 block text-aux font-medium text-t1">
              确认新密码
            </label>
            <input
              id="password2"
              type="password"
              autoComplete="new-password"
              className="kc-input"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              required
            />
          </div>

          {err && <div className="rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{err}</div>}
          {ok && <div className="rounded-md bg-ok/[.08] px-3 py-2.5 text-aux text-ok">{ok}</div>}

          <button type="submit" disabled={busy} className="kc-btn kc-btn-primary w-full">
            {busy ? '提交中…' : '重置密码'}
          </button>
        </form>

        <div className="mt-5 flex items-center justify-between text-aux">
          <Link href="/login" className="text-t3 hover:text-brand">
            返回登录
          </Link>
          <span className="text-t3">收不到邮件？请联系客服</span>
        </div>
      </div>
    </div>
  );
}
