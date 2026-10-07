/**
 * 套餐 → 视图模型
 *
 * 从现有前台（cardPriceOf / applyCardNode）移植取值规则，保证换前台后价格展示一致。
 */

import type { CardConfig, Plan, PlanView, PlanCardsResp } from '@/lib/types';
import { availabilityReason, normalizeAvailabilityState } from '@/lib/availability';

/** 后台未配置时的兜底承诺 */
const DEFAULT_GUARANTEES = ['失败全额退款', '安全省心'];
const DEFAULT_RULES = {
  account: '已登录的 ChatGPT 账号',
  fulfillment: '通常 3–5 分钟，具体以订单状态为准',
  restrictions: ['付款前请核对目标账号和套餐', '不要重复创建相同订单'],
  failure: '开通失败或长时间未完成，请从订单页申请售后，避免重复付款',
};

/** 周期键 → 展示单位（顺序即优先级） */
const PERIOD_ORDER: [keyof Plan, string][] = [
  ['month_price', '/月'],
  ['quarter_price', '/季'],
  ['half_year_price', '/半年'],
  ['year_price', '/年'],
  ['two_year_price', '/两年'],
  ['three_year_price', '/三年'],
];

/** 分 → 展示金额（整数时不显示小数） */
export function fenToText(fen: number): string {
  return (fen / 100).toFixed(fen % 100 === 0 ? 0 : 2);
}

/**
 * 取展示价格。
 * 后台配置为 manual 时用配置值；否则按周期优先级取套餐里第一个有值的。
 */
export function resolvePrice(plan: Plan, cfg: CardConfig | null): { num: string; unit: string } {
  const unit = cfg?.price?.unit || '';

  if (cfg?.price?.mode === 'manual' && cfg.price.value != null) {
    return { num: '$' + cfg.price.value, unit };
  }

  for (const [key, defUnit] of PERIOD_ORDER) {
    const v = plan[key];
    if (typeof v === 'number' && v > 0) {
      return { num: '$' + fenToText(v), unit: unit || defUnit };
    }
  }
  return { num: '价格待定', unit: '' };
}

/** 把套餐 + 卡片配置合成视图模型 */
export function toPlanView(
  plan: Plan,
  cfg: CardConfig | null,
  sellable = true,
  sellabilityReason = '',
  availabilityState?: string,
): PlanView {
  const c = cfg || {};
  const price = resolvePrice(plan, cfg);
  const state = normalizeAvailabilityState(availabilityState || c.state, sellable);
  const rules = c.rules || {};

  return {
    plan,
    cfg: c,
    category: c.category || 'recharge',
    state,
    sellable: state === 'onsale' && sellable,
    sellabilityReason: availabilityReason(state, sellabilityReason),
    rules: {
      account: rules.account || DEFAULT_RULES.account,
      fulfillment: rules.fulfillment || DEFAULT_RULES.fulfillment,
      restrictions: Array.isArray(rules.restrictions) && rules.restrictions.length
        ? rules.restrictions
        : DEFAULT_RULES.restrictions,
      failure: rules.failure || DEFAULT_RULES.failure,
    },
    title: c.title || plan.name,
    subtitle: c.subtitle || '',
    priceNum: price.num,
    priceUnit: price.unit,
    priceTag: c.price?.tag || '',
    features: Array.isArray(c.features) && c.features.length ? c.features : [],
    guarantees: Array.isArray(c.guarantees) && c.guarantees.length ? c.guarantees : DEFAULT_GUARANTEES,
    badge: c.badge?.text || '',
    buttonText: c.button?.text || '立即办理',
    tip: c.tip || '',
  };
}

/** 合并接口返回：只保留在售（show=1）且能卖的套餐 */
export function mergePlans(
  plans: Plan[],
  cfg: PlanCardsResp | null
): PlanView[] {
  const cards = cfg?.cards || {};
  const sellable = cfg?.sellable || {};
  const hasSellableMap = Boolean(cfg && cfg.sellable && typeof cfg.sellable === 'object');
  const availability = cfg?.availability || {};
  const reason = cfg?.supplier_health?.reason || '';
  return plans
    .filter((p) => p.show && p.sell)
    .map((p) => {
      const info = availability[String(p.id)];
      const isSellable = info
        ? info.sellable
        : hasSellableMap
          ? sellable[String(p.id)] !== false
          : true;
      return toPlanView(
        p,
        cards[String(p.id)] || null,
        isSellable,
        info?.reason || reason,
        info?.state,
      );
    });
}

/** 分类列表（后台可配，缺省给三类） */
export function categoriesOf(cfg: PlanCardsResp | null) {
  const list = cfg?.categories || [];
  if (list.length) return list;
  return [
    { key: 'recharge', name: '代充', nav: true },
    { key: 'account', name: '成品号', nav: true },
    { key: 'website', name: '建站服务', nav: true },
  ];
}
