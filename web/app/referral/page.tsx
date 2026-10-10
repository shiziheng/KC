import Link from 'next/link';

export default function ReferralPage() {
  return (
    <div className="kc-container py-12">
      <section className="kc-card mx-auto max-w-xl p-7 text-center">
        <span className="kc-tag kc-tag-mute">本期不提供</span>
        <h1 className="mt-4 text-h2 text-t1">推广与分销</h1>
        <p className="mt-3 text-body text-t2">分销、返佣和推广看板不属于当前代充业务重建范围，此入口暂不开放。</p>
        <Link href="/plan" className="kc-btn kc-btn-primary mt-5">返回代充商品</Link>
      </section>
    </div>
  );
}
