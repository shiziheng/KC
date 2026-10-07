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
          从账号准备、凭据粘贴，到余额支付、订单履约和售后处理，按步骤了解整个流程。
        </p>
      </header>

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
            <p className="mt-2 text-aux text-t2">先看看当前可售商品，再按向导逐步办理。</p>
            <div className="mt-4 flex flex-col gap-2">
              <Link href="/plan" className="kc-btn kc-btn-primary">查看商品 →</Link>
              <Link href="/order" className="kc-btn kc-btn-ghost">查看我的订单</Link>
            </div>
          </div>
          <div id="support" className="kc-card scroll-mt-24 p-5">
            <h2 className="text-h3 text-t1">需要处理订单问题？</h2>
            <p className="mt-2 text-aux text-t2">请从对应消费订单发起售后，附上订单号后几位和现象说明。</p>
            <Link href="/order" className="mt-4 inline-flex text-aux text-brand hover:underline">去我的订单 →</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
