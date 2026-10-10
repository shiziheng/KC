import Link from 'next/link';

export default function Home() {
  return (
    <div className="kc-container py-8 md:py-12">
      <section className="kc-card overflow-hidden">
        <div className="flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between md:p-10">
          <div className="max-w-2xl">
            <span className="kc-tag kc-tag-warn">Mock 演示环境</span>
            <h1 className="mt-3 text-h1 text-t1">代充业务流程预览</h1>
            <p className="mt-3 text-body text-t2">浏览运营后台配置的代充商品，创建模拟订单，并查看支付、履约、售后状态和交易凭证。当前不会收款、扣减余额或调用真实代充上游。</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/plan" className="kc-btn kc-btn-primary">浏览代充商品</Link>
              <Link href="/order" className="kc-btn kc-btn-ghost">我的模拟订单</Link>
            </div>
          </div>
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-aux text-amber-900 md:max-w-xs">
            <strong className="block text-body">Mock 安全说明</strong>
            <p className="mt-2">商品流程只写入独立业务库。模拟支付不移动资金，模拟履约不请求 ZovoCard 或其他供应商。</p>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-4 md:grid-cols-3">
        {[
          ['1', '选择商品', '运营人员在业务后台配置并上架代充商品。'],
          ['2', '创建模拟订单', '用户登录后可生成自己的 Mock 订单记录。'],
          ['3', '查看凭证与状态', '手动推进模拟支付/履约，或提交售后留言。'],
        ].map(([number, title, description]) => (
          <article key={number} className="kc-card p-5">
            <span className="kc-tag bg-brand-soft text-brand">步骤 {number}</span>
            <h2 className="mt-3 text-h3 text-t1">{title}</h2>
            <p className="mt-2 text-body text-t2">{description}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
