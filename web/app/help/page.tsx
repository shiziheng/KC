import Link from 'next/link';
import { HELP_QUICK_LINKS, HELP_SECTIONS } from '@/lib/help';

export const metadata = {
  title: '帮助中心 · KC 加速',
  description: '代充购买、凭据准备、订单履约和售后说明。',
};

export default function HelpPage() {
  return (
    <div className="kc-container py-8 md:py-12">
      <header className="max-w-2xl">
        <span className="kc-tag bg-brand-soft text-brand">帮助中心</span>
        <h1 className="mt-3 text-h1 text-t1">办理前看这里</h1>
        <p className="mt-2 text-body text-t2">
          当前是 Mock 演示版本。这里说明模拟下单、状态、售后留言和凭据范围。
        </p>
      </header>

      <div className="mt-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-aux text-amber-900">
        真实收款与真实开通尚未开放。请勿转账，也不要提供 ChatGPT Session、Token、Cookie、密码或支付凭据。
      </div>

      <nav aria-label="帮助目录" className="mt-6 flex flex-wrap gap-2">
        {HELP_QUICK_LINKS.map((item) => (
          <a key={item.id} href={'#' + item.id} className="kc-tag bg-card text-t2 ring-1 ring-line transition-colors hover:text-brand">
            {item.label}
          </a>
        ))}
      </nav>

      <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <main className="space-y-4">
          {HELP_SECTIONS.map((section) => (
            <section key={section.id} id={section.id} className="kc-card scroll-mt-24 p-5 md:p-6">
              <h2 className="text-h2 text-t1">{section.title}</h2>
              <p className="mt-2 text-body text-t2">{section.summary}</p>

              {section.steps && (
                <ol className="mt-4 space-y-2.5 text-body text-t2">
                  {section.steps.map((step, index) => (
                    <li key={step} className="flex gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-aux font-medium text-brand">
                        {index + 1}
                      </span>
                      <span className="pt-0.5">{step}</span>
                    </li>
                  ))}
                </ol>
              )}

              {section.notes && (
                <div className="mt-4 rounded-md bg-page px-3.5 py-3 text-aux text-t2">
                  <div className="font-medium text-t1">请注意</div>
                  <ul className="mt-1.5 space-y-1.5">
                    {section.notes.map((note) => <li key={note}>· {note}</li>)}
                  </ul>
                </div>
              )}
            </section>
          ))}
        </main>

        <aside className="h-fit space-y-4 lg:sticky lg:top-24">
          <div className="kc-card p-5">
            <h2 className="text-h3 text-t1">还没开始？</h2>
            <p className="mt-2 text-aux text-t2">先浏览当前可售的 Mock 商品，确认演示流程范围。</p>
            <div className="mt-4 flex flex-col gap-2">
              <Link href="/plan" className="kc-btn kc-btn-primary">查看商品 →</Link>
              <Link href="/order" className="kc-btn kc-btn-ghost">查看我的订单</Link>
            </div>
          </div>
          <div id="support" className="kc-card scroll-mt-24 p-5">
            <h2 className="text-h3 text-t1">需要处理订单问题？</h2>
            <p className="mt-2 text-aux text-t2">在线客服尚未接入。订单问题可在对应 Mock 订单中留言，由运营人员在后台查看。</p>
            <Link href="/order" className="mt-4 inline-flex text-aux text-brand hover:underline">去我的订单 →</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
