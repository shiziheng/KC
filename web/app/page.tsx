import Link from 'next/link';

/**
 * 第 0 段交付页：设计基线预览
 *
 * 这一页不是最终首页，而是把配色 / 字体 / 按钮 / 标签 / 卡片的样式集中展示出来，
 * 供确认视觉方向。第 2 段会把商品区换成真实数据，第 1 段会接上登录态。
 */
export default function Home() {
  return (
    <div className="kc-container py-8 md:py-12">
      {/* ── Hero ── */}
      <section className="kc-card overflow-hidden">
        <div className="flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between md:p-10">
          <div className="max-w-xl">
            <span className="kc-tag bg-brand-soft text-brand">官方渠道直充</span>
            <h1 className="mt-3 text-h1 text-t1">ChatGPT Plus 官方直充</h1>
            <p className="mt-3 text-body text-t2">
              使用你自己的账号开通，权益落在原账号上。付款后系统自动完成开通，
              一般 3~5 分钟内到账，失败自动回滚并全额退款。
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/plan" className="kc-btn kc-btn-primary">
                立即办理
              </Link>
              <Link href="/plan" className="kc-btn kc-btn-ghost">
                查看全部商品
              </Link>
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-3 gap-4 md:gap-6">
            {[
              { n: '3 分钟', d: '平均到账' },
              { n: '100%', d: '失败退款' },
              { n: 'USDT', d: '多种支付' },
            ].map((s) => (
              <div key={s.d} className="text-center">
                <div className="text-h3 text-brand">{s.n}</div>
                <div className="mt-0.5 text-aux text-t3">{s.d}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 示例商品卡片 ── */}
      <section className="mt-8">
        <h2 className="text-h2 text-t1">商品卡片（样式示意）</h2>
        <p className="mt-1 text-aux text-t3">第 2 段会接入真实数据。这里先确认卡片的信息层级。</p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {[
            { name: 'ChatGPT Plus 一个月', price: '$15', unit: '/月', tag: '主推', desc: '日常对话、写作与轻度任务', state: 'ok' as const },
            { name: 'ChatGPT Pro 一个月', price: '$45', unit: '/月', tag: '', desc: '重度使用、长上下文与更高额度', state: 'ok' as const },
            { name: 'ChatGPT Plus 三个月', price: '$42', unit: '', tag: '省 $3', desc: '一次开通三个月，更划算', state: 'warn' as const },
          ].map((c) => (
            <div key={c.name} className="kc-card flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-h3 text-t1">{c.name}</h3>
                {c.tag && <span className="kc-tag bg-brand-soft text-brand">{c.tag}</span>}
              </div>
              <p className="mt-1.5 text-aux text-t3">{c.desc}</p>

              <div className="mt-4 flex items-baseline gap-0.5">
                <span className="text-h1 text-brand">{c.price}</span>
                <span className="text-aux text-t3">{c.unit}</span>
              </div>

              <ul className="mt-4 flex-1 space-y-1.5 text-aux text-t2">
                <li>· 官方渠道直充，权益落在原账号</li>
                <li>· 3 分钟内自动到账</li>
                <li>· 开通失败全额退款</li>
              </ul>

              <button type="button" className="kc-btn kc-btn-primary mt-5 w-full">
                立即办理
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ── 设计元素总览 ── */}
      <section className="mt-10">
        <h2 className="text-h2 text-t1">设计元素（供确认）</h2>
        <p className="mt-1 text-aux text-t3">
          下面这些是全站共用的基础样式。确认后，后续所有页面都按这套走。
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {/* 配色 */}
          <div className="kc-card p-5">
            <h3 className="text-h3 text-t1">配色</h3>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {[
                { c: 'bg-brand', n: '品牌主色 #0d9488' },
                { c: 'bg-brand-deep', n: '品牌深色 #085041' },
                { c: 'bg-page', n: '页面底色 #f6f8fa' },
                { c: 'bg-t1', n: '标题文字 #0f172a' },
              ].map((x) => (
                <div key={x.n} className="flex items-center gap-2.5">
                  <span className={'h-8 w-8 shrink-0 rounded-md border border-line ' + x.c} />
                  <span className="text-aux text-t2">{x.n}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 按钮 */}
          <div className="kc-card p-5">
            <h3 className="text-h3 text-t1">按钮</h3>
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <button type="button" className="kc-btn kc-btn-primary">主按钮</button>
              <button type="button" className="kc-btn kc-btn-ghost">次按钮</button>
              <button type="button" className="kc-btn kc-btn-primary kc-btn-sm">小按钮</button>
              <button type="button" className="kc-btn kc-btn-primary" disabled>禁用</button>
            </div>
          </div>

          {/* 状态标签 */}
          <div className="kc-card p-5">
            <h3 className="text-h3 text-t1">状态标签</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="kc-tag kc-tag-ok">已到账</span>
              <span className="kc-tag kc-tag-warn">待支付</span>
              <span className="kc-tag kc-tag-err">处理失败</span>
              <span className="kc-tag kc-tag-mute">已失效</span>
            </div>
          </div>

          {/* 表单 */}
          <div className="kc-card p-5">
            <h3 className="text-h3 text-t1">输入框</h3>
            <div className="mt-3 space-y-3">
              <input className="kc-input" placeholder="请输入邮箱" />
              <input className="kc-input" placeholder="已聚焦状态" autoFocus />
            </div>
          </div>
        </div>
      </section>

      {/* ── 进度提示 ── */}
      <section className="mt-10">
        <div className="kc-card border-dashed p-5">
          <h3 className="text-h3 text-t1">第 0 段进度</h3>
          <ul className="mt-3 space-y-2 text-body">
            <li className="text-ok">✓ 项目骨架搭建完成</li>
            <li className="text-ok">✓ 设计基线（配色 / 字体 / 圆角）定稿</li>
            <li className="text-ok">✓ 顶栏 + 底栏 + 手机端响应式</li>
            <li className="text-ok">✓ 后端接口代理已配置（未接通数据）</li>
            <li className="text-t3">○ 第 1 段：用户体系（注册 / 登录 / 改密码）</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
