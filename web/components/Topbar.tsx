'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { formatUSD } from '@/lib/format';

const NAV = [
  { href: '/', label: '首页' },
  { href: '/plan', label: '商品' },
  { href: '/order', label: '我的订单' },
  { href: '/help', label: '帮助' },
];

export default function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, loggedIn, logout } = useAuth();

  const [menuOpen, setMenuOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);

  // 路由变化时收起移动端菜单
  useEffect(() => {
    setMenuOpen(false);
    setUserOpen(false);
  }, [pathname]);

  // 菜单展开时锁定页面滚动
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  // 点击外部收起用户下拉
  useEffect(() => {
    if (!userOpen) return;
    const onDown = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [userOpen]);

  const doLogout = () => {
    logout();
    setUserOpen(false);
    router.push('/');
  };

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-50 h-nav border-b border-line bg-card">
        <div className="kc-container flex h-full items-center gap-2">
          {/* 品牌 */}
          <Link href="/" className="flex shrink-0 items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-aux font-semibold text-white">
              KC
            </span>
            <span className="hidden text-h3 text-t1 sm:inline">KC 加速</span>
          </Link>

          {/* 桌面导航 */}
          <nav className="ml-6 hidden items-center gap-1 md:flex">
            {NAV.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    'rounded-md px-3.5 py-2 text-body transition-colors ' +
                    (active
                      ? 'bg-brand-soft font-medium text-brand'
                      : 'text-t3 hover:bg-black/[.04] hover:text-t1')
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* 右侧操作区 */}
          <div className="ml-auto flex items-center gap-2">
            <Link href="/topup" className="kc-btn kc-btn-primary kc-btn-sm md:px-4 md:py-2">
              立即充值
            </Link>

            {/* 登录态区域：加载中显示占位，避免「先显示登录按钮再跳成头像」的闪动 */}
            {loading ? (
              <div className="ml-1 hidden items-center gap-2 md:flex" aria-hidden="true">
                <span className="h-7 w-16 animate-pulse rounded-md bg-line" />
                <span className="h-8 w-8 animate-pulse rounded-full bg-line" />
              </div>
            ) : loggedIn && user ? (
              <>
                <span className="hidden h-7 w-px bg-line md:block" />
                <Link
                  href="/topup"
                  className="hidden rounded-md bg-brand-soft px-3 py-2 text-aux font-medium text-brand transition-colors hover:bg-brand/15 md:block"
                  title="账户余额"
                >
                  {formatUSD(user.balance)}
                </Link>

                <div ref={userRef} className="relative hidden md:block">
                  <button
                    type="button"
                    onClick={() => setUserOpen((v) => !v)}
                    aria-expanded={userOpen}
                    aria-label="账户菜单"
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-aux font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    {(user.email || 'U').charAt(0).toUpperCase()}
                  </button>

                  {userOpen && (
                    <div className="absolute right-0 top-[calc(100%+8px)] w-56 overflow-hidden rounded-lg border border-line bg-card shadow-lg">
                      <div className="border-b border-line px-3.5 py-2.5">
                        <div className="truncate text-aux font-medium text-t1">{user.email}</div>
                        <div className="mt-0.5 text-aux text-t3">
                          余额 {formatUSD(user.balance)}
                        </div>
                      </div>
                      <div className="p-1.5">
                        <Link
                          href="/profile"
                          className="block rounded-md px-3 py-2 text-body text-t2 transition-colors hover:bg-black/[.04] hover:text-brand"
                        >
                          个人中心
                        </Link>
                        <Link
                          href="/order"
                          className="block rounded-md px-3 py-2 text-body text-t2 transition-colors hover:bg-black/[.04] hover:text-brand"
                        >
                          我的订单
                        </Link>
                        <Link
                          href="/redeem"
                          className="block rounded-md px-3 py-2 text-body text-t2 transition-colors hover:bg-black/[.04] hover:text-brand"
                        >
                          兑换卡密
                        </Link>
                        <Link
                          href="/referral"
                          className="block rounded-md px-3 py-2 text-body text-t2 transition-colors hover:bg-black/[.04] hover:text-brand"
                        >
                          邀请返利
                        </Link>
                        <button
                          type="button"
                          onClick={doLogout}
                          className="block w-full rounded-md px-3 py-2 text-left text-body text-err transition-colors hover:bg-err/[.06]"
                        >
                          退出登录
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <Link
                  href="/redeem"
                  className="hidden rounded-md px-3 py-2 text-body text-t2 transition-colors hover:bg-black/[.04] hover:text-t1 md:block"
                >
                  兑换卡密
                </Link>
                <Link
                  href="/login"
                  className="hidden rounded-md px-3 py-2 text-body text-t2 transition-colors hover:bg-black/[.04] hover:text-t1 md:block"
                >
                  登录
                </Link>
              </>
            )}

            {/* 移动端汉堡 */}
            <button
              type="button"
              aria-label="打开菜单"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-md text-t1 transition-colors hover:bg-black/[.04] md:hidden"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                {menuOpen ? (
                  <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                ) : (
                  <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* 移动端抽屉 */}
      {menuOpen && (
        <div className="fixed inset-0 top-nav z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <nav className="relative border-b border-line bg-card p-3">
            {loggedIn && user && (
              <div className="mb-2 rounded-md bg-brand-soft px-3.5 py-3">
                <div className="truncate text-aux font-medium text-brand">{user.email}</div>
                <div className="mt-0.5 text-aux text-brand/80">余额 {formatUSD(user.balance)}</div>
              </div>
            )}

            {NAV.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    'block rounded-md px-3.5 py-3 text-body ' +
                    (active ? 'bg-brand-soft font-medium text-brand' : 'text-t2')
                  }
                >
                  {item.label}
                </Link>
              );
            })}
            <div className="my-2 h-px bg-line" />
            {loading ? null : loggedIn ? (
              <>
                <Link href="/profile" className="block rounded-md px-3.5 py-3 text-body text-t2">
                  个人中心
                </Link>
                <Link href="/redeem" className="block rounded-md px-3.5 py-3 text-body text-t2">
                  兑换卡密
                </Link>
                <Link href="/referral" className="block rounded-md px-3.5 py-3 text-body text-t2">
                  邀请返利
                </Link>
                <button
                  type="button"
                  onClick={doLogout}
                  className="block w-full rounded-md px-3.5 py-3 text-left text-body text-err"
                >
                  退出登录
                </button>
              </>
            ) : (
              <>
                <Link href="/redeem" className="block rounded-md px-3.5 py-3 text-body text-t2">
                  兑换卡密
                </Link>
                <Link href="/referral" className="block rounded-md px-3.5 py-3 text-body text-t2">
                  邀请返利
                </Link>
                <Link href="/login" className="block rounded-md px-3.5 py-3 text-body text-t2">
                  登录 / 注册
                </Link>
              </>
            )}
          </nav>
        </div>
      )}
    </>
  );
}
