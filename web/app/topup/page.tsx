import Link from 'next/link';

export default function TopupPage() {
  return (
    <div className="kc-container py-12">
      <section className="kc-card mx-auto max-w-2xl p-7 md:p-9">
        <span className="kc-tag kc-tag-warn">暂未开放真实充值</span>
        <h1 className="mt-4 text-h1 text-t1">USDT 充值</h1>
        <p className="mt-3 text-body text-t2">当前重建阶段只验证模拟订单流程，尚未接入真实收款钱包或区块链到账识别。</p>
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-aux text-amber-900">本页面不会创建充值单、打开收银台、接收 USDT 或改变账户余额。请不要向任何地址转账。</p>
        <div className="mt-6 flex flex-wrap gap-2"><Link href="/plan" className="kc-btn kc-btn-primary">返回商品</Link><Link href="/help" className="kc-btn kc-btn-ghost">查看帮助</Link></div>
      </section>
    </div>
  );
}
