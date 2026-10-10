'use strict';

const zovoCard = require('../zovocard-client');
const { BusinessError } = require('./validation');

function zovoConfigFromEnvironment() {
    return {
        base_url: String(process.env.ZOVOCARD_BASE_URL || '').trim(),
        api_key: String(process.env.ZOVOCARD_API_KEY || '').trim()
    };
}

function buildMockUpstreamOrderMapping({
    orderRef,
    productRef,
    productName,
    catalogSource,
    catalogVersion,
    serviceFeeUsdMinor,
    isCredit,
    requiresActiveSubscription
}) {
    const fee = serviceFeeUsdMinor === null || serviceFeeUsdMinor === undefined
        ? null
        : Number(serviceFeeUsdMinor);
    return {
        provider: 'zovocard',
        product: 'gpt',
        product_name: String(productName || productRef || '').trim(),
        plan: String(productRef || '').trim(),
        product_ref: String(productRef || '').trim(),
        client_request_id: String(orderRef || '').trim(),
        order_ref: null,
        status: 'not_submitted',
        mode: 'mock',
        catalog_source: String(catalogSource || 'legacy_mapping'),
        catalog_version: catalogVersion ?? null,
        service_fee_usd_minor: Number.isSafeInteger(fee) && fee >= 0 ? fee : null,
        is_credit: isCredit === true,
        requires_active_subscription: requiresActiveSubscription === true
    };
}

async function readZovoCatalog(fetchPlans = zovoCard.fetchPlans) {
    const result = await fetchPlans(zovoConfigFromEnvironment());
    if (!result?.success) {
        throw new BusinessError(503, 'UPSTREAM_CATALOG_UNAVAILABLE', '暂时无法读取上游商品目录；商品未保存');
    }
    const allPlans = Array.isArray(result.plans)
        ? result.plans
        : [...(result.gptPlans || []), ...(result.creditPlans || [])];
    const plans = allPlans
        .map((plan) => ({
            key: String(plan?.key || '').trim(),
            name: String(plan?.name || plan?.label || plan?.key || '').trim(),
            product: String(plan?.product || 'gpt').trim().toLowerCase(),
            accPlanKey: String(plan?.accPlanKey || plan?.key || '').trim(),
            enabled: plan?.enabled === true,
            purchasable: plan?.purchasable === true,
            isCredit: plan?.isCredit === true,
            requiresActiveSubscription: plan?.requiresActiveSubscription === true,
            renewalOnly: String(plan?.key || '').trim() === 'pro_20x_renew',
            serviceFeeUsdMinor: Number.isSafeInteger(plan?.serviceFeeUsdMinor) && plan.serviceFeeUsdMinor >= 0
                ? plan.serviceFeeUsdMinor
                : null,
            paymentRegions: Array.isArray(plan?.paymentRegions)
                ? plan.paymentRegions.map((region) => String(region || '').trim().toUpperCase()).filter(Boolean).slice(0, 32)
                : []
        }))
        .filter((plan) => /^[a-z0-9][a-z0-9_-]{1,63}$/.test(plan.key) && plan.name && plan.product === 'gpt');

    return {
        provider: 'zovocard',
        mode: result.mock === true ? 'MOCK' : 'LIVE',
        catalogVersion: result.catalogVersion ?? result.raw?.version ?? null,
        catalogFixture: result.catalogFixture || null,
        paymentRegions: Array.isArray(result.raw?.payment_regions)
            ? result.raw.payment_regions.map((region) => ({
                country: String(region?.country || '').trim().toUpperCase(),
                currency: String(region?.currency || '').trim().toUpperCase()
            })).filter((region) => region.country && region.currency)
            : [],
        fetchedAt: new Date().toISOString(),
        plans
    };
}

async function assertPurchasableZovoPlan(planCode, fetchPlans) {
    const catalog = await readZovoCatalog(fetchPlans);
    const plan = catalog.plans.find((item) => item.key === planCode);
    if (!plan || !plan.enabled || !plan.purchasable || plan.renewalOnly) {
        const sourceLabel = catalog.mode === 'MOCK' ? 'Mock 文档样例目录' : '上游当前可售目录';
        throw new BusinessError(400, 'ZOVO_PLAN_UNAVAILABLE', `该套餐不在${sourceLabel}的普通可售范围内，不能新增或修改商品`);
    }
    return { catalog, plan };
}

module.exports = { readZovoCatalog, assertPurchasableZovoPlan, buildMockUpstreamOrderMapping };
