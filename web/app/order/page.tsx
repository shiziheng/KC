'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import {
  fetchStorefrontOrders,
  simulateMockFulfillment,
  simulateMockPayment,
  submitAfterSales,
  type StorefrontOrder,
} from '@/lib/storefront';

const PAYMENT_LABEL: Record<string, string> = { unpaid: '待模拟支付', paid: '模拟已支付', manual_review: '待人工核验', failed: '失败' };
const FULFILLMENT_LABEL: Record<string, string> = { pending: '待模拟处理', running: '模拟处理中', completed: '模拟完成', failed: '失败', manual: '待人工处理', not_required: '无需处理' };
const AFTER_SALES_LABEL: Record<string, string> = { none: '无售后申请', pending: '待受理', reviewing: '处理中', approved: '已同意（不代表退款）', rejected: '已拒绝', completed: '已结案（不代表退款）' };

function timeText(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
}

export default function OrderPage() {
  const { loggedIn, loading: authLoading } = useAuth();
  const [orders, setOrders] = useState<StorefrontOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyRef, setBusyRef] = useState('');
  const [draftRef, setDraftRef] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<StorefrontOrder | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const result = await fetchStorefrontOrders();
    if (!result.ok) {
      setError(result.message || '订单加载失败，请重新登录后重试');
      setOrders([]);
    } else {
      setOrders(result.data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (loggedIn) void load();
    else { setOrders([]); setLoading(false); }
  }, [authLoading, loggedIn, load]);

  async function doAction(order: StorefrontOrder, action: 'payment' | 'fulfillment') {
    if (busyRef) return;
    setBusyRef(order.orderRef);
    setError('');
    setNotice('');
    const result = action === 'payment'
      ? await simulateMockPayment(order.orderRef)
      : await simulateMockFulfillment(order.orderRef);
    setBusyRef('');
    if (!result.ok) { setError(result.message || '操作失败，请重试'); return; }
    setNotice(result.data?.message || '模拟状态已更新');
    await load();
  }

  async function doAfterSales(orderRef: string) {
    if (busyRef || reason.trim().length < 6) {
      setError('请填写至少 6 个字符的情况说明；不要粘贴账号授权信息或密码。');
      return;
    }
    setBusyRef(orderRef);
    setError('');
    const result = await submitAfterSales(orderRef, reason.trim());
    setBusyRef('');
    if (!result.ok) { setError(result.message || '售后申请提交失败'); return; }
    setDraftRef('');
    setReason('');
    setNotice(result.data?.message || '售后申请已提交');
    await load();
  }

  if (!authLoading && !loggedIn) {
    return (
      <div className="kc-container py-12">
        <div className="kc-card mx-auto max-w-md p-8 text-center">
          <h1 className="text-h2 text-t1">登录后查看订单</h1>
          <p className="mt-2 text-body text-t2">登录后可查看你在独立代充业务中的模拟订单和凭证。</p>
          <Link href="/login?redirect=/order" className="kc-btn kc-btn-primary mt-5">登录 / 注册</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="kc-container py-8 md:py-12">
      <style jsx global>{`@media print { body * { visibility: hidden !important; } #mock-receipt, #mock-receipt * { visibility: visible !important; } #mock-receipt { position: fixed; inset: 0; width: 100%; border: 0; box-shadow: none; } }`}</style>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-h1 text-t1">我的模拟订单</h1><p className="mt-1 text-aux text-t3">仅显示独立业务库中的订单，不读取或修改 Xboard 旧订单。</p></div>
        <button type="button" disabled={loading} onClick={() => void load()} className="kc-btn kc-btn-ghost kc-btn-sm">{loading ? '刷新中…' : '刷新'}</button>
      </header>

      <div className="mt-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-aux text-amber-900">
        所有支付与履约状态均为模拟记录：不会收取 USDT、扣减任何余额、调用 ZovoCard 或真实开通服务。页面生成的凭证不是付款证明或发票。
      </div>
      {notice && <div className="mt-4 rounded-md bg-brand-soft px-3 py-2.5 text-aux text-brand">{notice}</div>}
      {error && <div className="mt-4 rounded-md bg-err/[.07] px-3 py-2.5 text-aux text-err">{error}</div>}

      {loading ? <div className="mt-5 space-y-3">{[0, 1].map((item) => <div key={item} className="kc-card h-36 animate-pulse" />)}</div> : orders.length ? (
        <div className="mt-5 space-y-3">
          {orders.map((order) => (
            <article key={order.orderRef} className="kc-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h2 className="text-h3 text-t1">{order.productName}</h2><p className="mt-1 font-mono text-aux text-t3">{order.orderRef}</p></div>
                <strong className="text-h3 text-brand">{order.amount} {order.currency}</strong>
              </div>
              <div className="mt-4 grid gap-2 text-aux text-t2 sm:grid-cols-3">
                <div>支付：<span className="font-medium">{PAYMENT_LABEL[order.paymentStatus] || order.paymentStatus}</span></div>
                <div>履约：<span className="font-medium">{FULFILLMENT_LABEL[order.fulfillmentStatus] || order.fulfillmentStatus}</span></div>
                <div>售后：<span className="font-medium">{AFTER_SALES_LABEL[order.afterSalesStatus] || order.afterSalesStatus}</span></div>
              </div>
              <p className="mt-2 text-aux text-t3">创建时间：{timeText(order.createdAt)}{order.completedAt ? ` · 处理时间：${timeText(order.completedAt)}` : ''}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {order.paymentStatus === 'unpaid' && <button type="button" disabled={busyRef === order.orderRef} onClick={() => void doAction(order, 'payment')} className="kc-btn kc-btn-primary kc-btn-sm">{busyRef === order.orderRef ? '处理中…' : '模拟支付（不扣款）'}</button>}
                {order.paymentStatus === 'paid' && ['pending', 'running'].includes(order.fulfillmentStatus) && <button type="button" disabled={busyRef === order.orderRef} onClick={() => void doAction(order, 'fulfillment')} className="kc-btn kc-btn-primary kc-btn-sm">模拟履约（不调用上游）</button>}
                <button type="button" onClick={() => setReceipt(order)} className="kc-btn kc-btn-ghost kc-btn-sm">查看交易凭证</button>
                {order.afterSalesStatus === 'none' && order.paymentStatus !== 'failed' && <button type="button" onClick={() => { setDraftRef(draftRef === order.orderRef ? '' : order.orderRef); setError(''); }} className="kc-btn kc-btn-ghost kc-btn-sm">申请售后 / 留言</button>}
              </div>
              {draftRef === order.orderRef && (
                <div className="mt-4 rounded-md bg-page p-4">
                  <label htmlFor={'reason-' + order.orderRef} className="mb-1.5 block text-aux font-medium text-t1">说明遇到的问题（不会自动退款）</label>
                  <textarea id={'reason-' + order.orderRef} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} rows={3} className="kc-input w-full" placeholder="请描述订单问题。不要填写密码、Session、Token、Cookie 或支付凭据。" />
                  <div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => setDraftRef('')} className="kc-btn kc-btn-ghost kc-btn-sm">取消</button><button type="button" disabled={busyRef === order.orderRef} onClick={() => void doAfterSales(order.orderRef)} className="kc-btn kc-btn-primary kc-btn-sm">提交留言</button></div>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="kc-card mt-5 p-10 text-center"><p className="text-body text-t2">还没有模拟订单</p><Link href="/plan" className="kc-btn kc-btn-primary mt-4">浏览代充商品</Link></div>
      )}

      {receipt && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/45 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReceipt(null); }}>
          <section id="mock-receipt" role="dialog" aria-modal="true" className="kc-card w-full max-w-xl p-6">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="kc-tag kc-tag-warn">模拟交易凭证 · 非发票</p><h2 className="mt-3 text-h2 text-t1">订单状态记录</h2></div><button type="button" onClick={() => setReceipt(null)} className="kc-btn kc-btn-ghost kc-btn-sm print:hidden">关闭</button></div>
            <dl className="mt-5 grid gap-3 text-body sm:grid-cols-2">
              <div><dt className="text-aux text-t3">订单号</dt><dd className="mt-1 break-all font-mono text-t1">{receipt.orderRef}</dd></div>
              <div><dt className="text-aux text-t3">商品</dt><dd className="mt-1 text-t1">{receipt.productName}</dd></div>
              <div><dt className="text-aux text-t3">记录金额</dt><dd className="mt-1 text-t1">{receipt.amount} {receipt.currency}</dd></div>
              <div><dt className="text-aux text-t3">支付状态</dt><dd className="mt-1 text-t1">{PAYMENT_LABEL[receipt.paymentStatus] || receipt.paymentStatus}</dd></div>
              <div><dt className="text-aux text-t3">履约状态</dt><dd className="mt-1 text-t1">{FULFILLMENT_LABEL[receipt.fulfillmentStatus] || receipt.fulfillmentStatus}</dd></div>
              <div><dt className="text-aux text-t3">生成时间</dt><dd className="mt-1 text-t1">{timeText(receipt.createdAt)}</dd></div>
            </dl>
            <p className="mt-5 border-t border-line pt-4 text-aux text-t3">此凭证只证明业务系统中的模拟订单状态，不证明真实收款，也不代表真实服务已开通；不可用于报销或开票。</p>
            <div className="mt-4 flex justify-end print:hidden"><button type="button" onClick={() => window.print()} className="kc-btn kc-btn-primary kc-btn-sm">打印 / 保存 PDF</button></div>
          </section>
        </div>
      )}
    </div>
  );
}
