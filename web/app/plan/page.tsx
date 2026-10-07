'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import GuideModal from '@/components/GuideModal';
import PlanCard from '@/components/PlanCard';
import { api, pg } from '@/lib/api';
import { categoriesOf, mergePlans } from '@/lib/plans';
import type { Category, Plan, PlanCardsResp, PlanView } from '@/lib/types';

export default function PlanPage() {
  const { loggedIn, loading: authLoading } = useAuth();
  const router = useRouter();

  const [plans, setPlans] = useState<PlanView[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [faq, setFaq] = useState<{ q: string; a: string }[]>([]);
  const [activeCat, setActiveCat] = useState('');
  const [guide, setGuide] = useState<PlanView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');

    // 卡片配置是公开接口
    const cfgRes = await pg.get<PlanCardsResp>('/plan/kc-cards', { auth: false });
    const cfg = cfgRes.ok && cfgRes.data ? cfgRes.data : null;

    if (cfg) {
      setCats(categoriesOf(cfg));
      setFaq(Array.isArray(cfg.faq) ? cfg.faq : []);
    } else {
      setCats(categoriesOf(null));
    }

    // 商品列表：登录用用户接口，游客用公开接口（开放游客浏览商品与价格；
    // 购买动作仍要求登录——点击「立即办理」时引导）
    // ⚠️ 该版本 Xboard 的游客套餐路由是 guest/plan/fetch（无 guest/plan/list）
    const pRes = loggedIn
      ? await api.get<Plan[] | Record<string, Plan>>('/v1/user/plan/fetch')
      : await api.get<Plan[] | Record<string, Plan>>('/v1/guest/plan/fetch');

    if (!pRes.ok) {
      setErr(pRes.message || '商品加载失败，请稍后重试');
      setLoading(false);
      return;
    }

    const raw = pRes.data;
    const list: Plan[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.values(raw)
        : [];

    setPlans(mergePlans(list, cfg));
    setLoading(false);
  }, [loggedIn]);

  useEffect(() => {
    if (!authLoading) void load();
  }, [authLoading, load]);

  // 首次加载完成后，默认选中第一个有商品的分类
  useEffect(() => {
    if (!activeCat && plans.length) setActiveCat(plans[0].category);
  }, [plans, activeCat]);

  /** 游客点击购买 → 引导登录（登录后回到本页）；登录用户 → 打开代充向导 */
  const openPlan = useCallback(
    (v: PlanView) => {
      if (!loggedIn) {
        router.push('/login?redirect=' + encodeURIComponent('/plan'));
        return;
      }
      setGuide(v);
    },
    [loggedIn, router]
  );

  const shown = activeCat ? plans.filter((p) => p.category === activeCat) : plans;
  const usedCats = cats.filter((c) => plans.some((p) => p.category === c.key));

  return (
    <div className="kc-container py-8 md:py-12">
      <header>
        <h1 className="text-h1 text-t1">商品</h1>
        <p className="mt-1.5 text-body text-t2">
          选择需要的服务，用账户余额支付，系统自动完成开通。
        </p>
        <Link href="/help#purchase" className="mt-2 inline-flex text-aux text-brand hover:underline">
          购买前须知 →
        </Link>
      </header>

      {/* 分类切换 */}
      {usedCats.length > 1 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {usedCats.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setActiveCat(c.key)}
              className={
                'rounded-md px-3.5 py-2 text-body transition-colors ' +
                (activeCat === c.key
                  ? 'bg-brand-soft font-medium text-brand'
                  : 'text-t3 hover:bg-black/[.04] hover:text-t1')
              }
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* 加载中 */}
      {loading && (
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="kc-card h-72 animate-pulse" />
          ))}
        </div>
      )}

      {/* 出错 */}
      {!loading && err && (
        <div className="kc-card mt-6 p-6 text-center">
          <p className="text-body text-err">{err}</p>
          <button type="button" onClick={() => void load()} className="kc-btn kc-btn-ghost mt-4">
            重试
          </button>
        </div>
      )}

      {/* 商品网格（游客也可见；点击购买时引导登录） */}
      {!loading && !err && (
        <>
          {shown.length > 0 ? (
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {shown.map((v) => (
                <PlanCard key={v.plan.id} view={v} onOpen={openPlan} />
              ))}
            </div>
          ) : (
            <div className="kc-card mt-6 p-10 text-center">
              <p className="text-body text-t3">该分类下暂无在售商品</p>
            </div>
          )}
        </>
      )}

      {/* 游客提示条 */}
      {!authLoading && !loggedIn && !err && (
        <div className="mt-6 rounded-md bg-brand-soft px-4 py-3.5 text-aux text-t2">
          浏览无需登录。点击「立即办理」时会引导你登录或注册，登录后使用账户余额支付。
        </div>
      )}

      {/* 常见问题 */}
      {faq.length > 0 && (
        <section className="mt-12">
          <h2 className="text-h2 text-t1">常见问题</h2>
          <div className="mt-4 space-y-2">
            {faq.map((f, i) => (
              <FaqItem key={i} q={f.q} a={f.a} />
            ))}
          </div>
        </section>
      )}

      {/* 代充向导 */}
      {guide && (
        <GuideModal
          view={guide}
          onClose={() => {
            setGuide(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="kc-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
      >
        <span className="text-body font-medium text-t1">{q}</span>
        <span className={'shrink-0 text-t3 transition-transform ' + (open ? 'rotate-180' : '')}>▾</span>
      </button>
      {open && <div className="border-t border-line px-4 py-3.5 text-body text-t2">{a}</div>}
    </div>
  );
}
