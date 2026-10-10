import Link from 'next/link';

export default function RedeemPage() {
  return (
    <div className="kc-container py-12">
      <section className="kc-card mx-auto max-w-2xl p-7 md:p-9">
        <span className="kc-tag kc-tag-warn">真实履约已关闭</span>
        <h1 className="mt-4 text-h1 text-t1">代充开通</h1>
        <p className="mt-3 text-body text-t2">当前只支持浏览商品、创建模拟订单、模拟支付和模拟履约状态。真实上游调用保持关闭。</p>
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-aux text-amber-900">此阶段不需要也不要提交 ChatGPT Session、Token、Cookie、密码或卡密。本页面不会接收任何授权凭据。</p>
        <div className="mt-6 flex flex-wrap gap-2"><Link href="/plan" className="kc-btn kc-btn-primary">浏览商品</Link><Link href="/order" className="kc-btn kc-btn-ghost">查看模拟订单</Link></div>
      </section>
    </div>
  );
}
