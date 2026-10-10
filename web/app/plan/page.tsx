'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { createMockOrder, fetchStorefrontProducts, type StorefrontProduct } from '@/lib/storefront';

function price(product: StorefrontProduct) {
  const prefix = product.currency === 'USD' ? '$' : '';
  return `${prefix}${product.sellingAmount} ${product.currency === 'USDT' ? 'USDT' : ''}`.trim();
}

export default function PlanPage() {
  const { loggedIn, loading: authLoading } = useAuth();
  const router = useRouter();
  const [products, setProducts] = useState<StorefrontProduct[]>([]);
  const [selected, setSelected] = useState<StorefrontProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const result = await fetchStorefrontProducts();
    if (!result.ok || !result.data) {
      setError(result.message || '商品暂时无法加载，请稍后重试');
      setProducts([]);
    } else {
      setProducts(result.data.filter((item) => item.availability === 'onsale'));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function beginOrder() {
    if (!selected || busy) return;
    if (!loggedIn) {
      router.push('/login?redirect=' + encodeURIComponent('/plan'));
      return;
    }
    setBusy(true);
    const result = await createMockOrder(selected.id);
    setBusy(false);
    if (!result.ok || !result.data?.orderRef) {
      setError(result.message || '模拟订单创建失败，请重试');
      return;
    }
    setSelected(null);
    router.push('/order');
  }

  return (
    <div className="kc-container py-8 md:py-12">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1 text-t1">代充商品</h1>
          <p className="mt-1.5 text-body text-t2">商品价格由运营后台维护；当前仅支持模拟下单，不会收款或真实开通。</p>
        </div>
        <span className="kc-tag kc-tag-warn">MOCK 演示 · 不扣款</span>
      </header>

      <div className="notice mt-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-aux text-amber-900">
        当前阶段不会发起 USDT 收款、余额扣款或上游代充。模拟状态仅用于核对网站流程，不代表实际付款或开通结果。
      </div>

      {error && <div className="mt-4 rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{error}</div>}
      {loading ? (
        <div className="mt-6 grid gap-4 md:grid-cols-3">{[0, 1, 2].map((n) => <div key={n} className="kc-card h-64 animate-pulse" />)}</div>
      ) : products.length ? (
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {products.map((product) => (
            <article key={product.id} className="kc-card flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-h3 text-t1">{product.name}</h2>
                <span className="kc-tag bg-brand-soft text-brand">Mock 商品</span>
              </div>
              <p className="mt-2 text-aux text-t3">套餐类型：{product.planCode.replace('_', ' ')}</p>
              {product.isCredit && <p className="mt-2 text-aux text-t2">Codex 点数加购；上游要求目标账号已有有效 Plus / Pro 订阅。当前页面仍是 Mock 演练。</p>}
              <div className="mt-5 text-h1 text-brand">{price(product)}</div>
              <p className="mt-2 flex-1 text-aux text-t2">标称金额 {product.faceAmount} {product.currency}。订单支付和处理状态只在模拟环境中推进。</p>
              <button type="button" onClick={() => setSelected(product)} className="kc-btn kc-btn-primary mt-5 w-full">
                创建模拟订单
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="kc-card mt-6 p-8 text-center">
          <p className="text-body text-t2">当前没有可售代充商品</p>
          <button type="button" onClick={() => void load()} className="kc-btn kc-btn-ghost mt-4">重新加载</button>
        </div>
      )}

      <p className="mt-6 text-aux text-t3">已有模拟订单？<Link href="/order" className="ml-1 text-brand hover:underline">查看订单和凭证</Link></p>

      {selected && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setSelected(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="mock-order-title" className="kc-card w-full max-w-lg p-6">
            <h2 id="mock-order-title" className="text-h2 text-t1">确认模拟订单</h2>
            <div className="mt-4 rounded-md bg-page p-4 text-body text-t2">
              <div className="flex justify-between gap-4"><span>商品</span><strong className="text-t1">{selected.name}</strong></div>
              <div className="mt-2 flex justify-between gap-4"><span>金额</span><strong className="text-brand">{price(selected)}</strong></div>
            </div>
            <p className="mt-4 text-aux text-t3">确认后仅在独立业务库创建一张未支付的 Mock 订单。之后可手动推进模拟支付和履约；不会连接支付网关、ZovoCard 或其他上游。</p>
            {!authLoading && !loggedIn && <p className="mt-3 text-aux text-warn">创建订单前需要先登录。</p>}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setSelected(null)} disabled={busy} className="kc-btn kc-btn-ghost">取消</button>
              <button type="button" onClick={() => void beginOrder()} disabled={busy || authLoading} className="kc-btn kc-btn-primary">
                {busy ? '正在创建…' : loggedIn ? '确认创建（不扣款）' : '登录后继续'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
