export const AVAILABILITY_STATES = ['onsale', 'soon', 'soldout', 'manual'] as const;

export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/**
 * 将后台卡片状态和供应商 sellable 结果合并为前台统一四态。
 * legacy featured/recommend 只影响角标，不会阻止正常购买。
 */
export function normalizeAvailabilityState(state: unknown, sellable: boolean): AvailabilityState {
  const raw = String(state || 'onsale');
  if (raw === 'manual') return 'manual';
  if (raw === 'soon') return 'soon';
  if (raw === 'soldout') return 'soldout';
  return sellable ? 'onsale' : 'soldout';
}

export function availabilityReason(
  state: AvailabilityState,
  supplierReason = '',
): string | undefined {
  if (state === 'soon') return '服务即将上线，暂不接受自动办理';
  if (state === 'manual') return '该商品需要人工确认，请先查看办理规则';
  if (state === 'soldout') return supplierReason || '当前商品暂不可售，请稍后重试';
  return undefined;
}
