'use strict';

const axios = require('axios');
const zovoCard = require('../zovocard-client');
const { assertPurchasableZovoPlan, readZovoCatalog, buildMockUpstreamOrderMapping } = require('../business/zovo-catalog');

describe('Zovo product catalog adapter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('uses a documentation fixture in mock mode without sending a request upstream', async () => {
        vi.stubEnv('REQUIRE_ZOVOCARD_MOCK', '1');
        vi.stubEnv('ZOVOCARD_MOCK', '1');
        const request = vi.spyOn(axios, 'request');

        const catalog = await readZovoCatalog();

        expect(request).not.toHaveBeenCalled();
        expect(catalog).toMatchObject({ provider: 'zovocard', mode: 'MOCK', catalogFixture: 'zovocard-openapi-en-2026-10-08' });
        expect(catalog.plans.map((plan) => plan.key)).toEqual(expect.arrayContaining([
            'go', 'plus', 'pro_5x', 'pro_20x', 'pro_50x', 'pro_20x_renew',
            'credit250', 'credit500', 'credit1000', 'credit2500', 'credit5000', 'credit25000'
        ]));
    });

    it('uses registry keys and checks both ACC enabled and supplier purchasable flags', async () => {
        vi.stubEnv('REQUIRE_ZOVOCARD_MOCK', '0');
        vi.stubEnv('ZOVOCARD_MOCK', '0');
        // F1 后客户端 base_url 以 cfg（调用方/DB）优先、env 作兜底；此处清空 env 以保证断言使用 cfg.base_url 且不受环境污染。
        vi.stubEnv('ZOVOCARD_BASE_URL', '');
        const request = vi.spyOn(axios, 'request').mockResolvedValue({
            status: 200,
            data: {
                code: 0,
                msg: 'ok',
                data: {
                    version: 214,
                    plans: {
                        go: { enabled: true, serviceFeeUsdMinor: 15 },
                        plus: { enabled: true, serviceFeeUsdMinor: 15 },
                        pro_50x: { enabled: false, serviceFeeUsdMinor: 15 },
                        credit250: { enabled: true, serviceFeeUsdMinor: 15 }
                    },
                    registry: [
                        { key: 'go', product: 'gpt', acc_plan_key: 'go', label: 'Go', purchasable: true, is_credit: false, service_fee_usd_minor: 15 },
                        { key: 'plus', product: 'gpt', acc_plan_key: 'plus', label: 'Plus', purchasable: false, is_credit: false },
                        { key: 'pro_50x', product: 'gpt', acc_plan_key: 'pro_50x', label: 'Pro 50x', purchasable: true, is_credit: false },
                        { key: 'credit250', product: 'gpt', acc_plan_key: 'credit250', label: 'Credits 250', purchasable: true, is_credit: true, requires_active_subscription: true, service_fee_usd_minor: 15 },
                        { key: 'pro', product: 'claude', acc_plan_key: 'claude_pro', label: 'Claude Pro', purchasable: true, is_credit: false }
                    ],
                    payment_regions: [{ country: 'PH', currency: 'PHP' }, { country: 'US', currency: 'USD' }]
                }
            }
        });

        const result = await zovoCard.fetchPlans({ base_url: 'https://zovo.test/openapi/v1', api_key: 'test-key' });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'GET',
            url: 'https://zovo.test/openapi/v1/gpt-direct/plans?product=gpt'
        }));
        expect(result.plans.map((plan) => plan.key)).toEqual(['go', 'plus', 'pro_50x', 'credit250']);
        expect(result).toMatchObject({ catalogVersion: 214 });
        expect(result.creditPlans[0]).toMatchObject({ isCredit: true, requiresActiveSubscription: true, serviceFeeUsdMinor: 15 });

        const catalog = await readZovoCatalog(async () => result);
        expect(catalog).toMatchObject({ catalogVersion: 214 });
        expect(catalog.plans.find((plan) => plan.key === 'pro_50x')).toMatchObject({ enabled: false, purchasable: true });
        expect(catalog.paymentRegions).toEqual([{ country: 'PH', currency: 'PHP' }, { country: 'US', currency: 'USD' }]);
        await expect(assertPurchasableZovoPlan('pro_50x', async () => result)).rejects.toMatchObject({ code: 'ZOVO_PLAN_UNAVAILABLE' });
        await expect(assertPurchasableZovoPlan('plus', async () => result)).rejects.toMatchObject({ code: 'ZOVO_PLAN_UNAVAILABLE' });
        await expect(assertPurchasableZovoPlan('go', async () => result)).resolves.toMatchObject({ plan: { key: 'go' } });
    });

    it('prefers caller/DB cfg over env for base_url and api_key (F1)', async () => {
        vi.stubEnv('REQUIRE_ZOVOCARD_MOCK', '0');
        vi.stubEnv('ZOVOCARD_MOCK', '0');
        vi.stubEnv('ZOVOCARD_BASE_URL', 'https://env.zovo.test/openapi/v1');
        vi.stubEnv('ZOVOCARD_API_KEY', 'env-key');
        const request = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { code: 0, msg: 'ok', data: { version: 1, registry: [], plans: {} } } });

        await zovoCard.fetchPlans({ base_url: 'https://db.zovo.test/openapi/v1', api_key: 'db-key' });

        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://db.zovo.test/openapi/v1/gpt-direct/plans?product=gpt',
            headers: expect.objectContaining({ 'X-API-Key': 'db-key' })
        }));
    });

    it('falls back to env base_url/api_key when cfg is empty (F1)', async () => {
        vi.stubEnv('REQUIRE_ZOVOCARD_MOCK', '0');
        vi.stubEnv('ZOVOCARD_MOCK', '0');
        vi.stubEnv('ZOVOCARD_BASE_URL', 'https://env.zovo.test/openapi/v1');
        vi.stubEnv('ZOVOCARD_API_KEY', 'env-key');
        const request = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { code: 0, msg: 'ok', data: { version: 1, registry: [], plans: {} } } });

        await zovoCard.fetchPlans({});

        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://env.zovo.test/openapi/v1/gpt-direct/plans?product=gpt',
            headers: expect.objectContaining({ 'X-API-Key': 'env-key' })
        }));
    });

    it('does not treat renewal attachment as an ordinary product sale', async () => {
        await expect(assertPurchasableZovoPlan('pro_20x_renew', async () => ({
            success: true,
            mock: true,
            plans: [{ key: 'pro_20x_renew', name: 'Pro renewal', product: 'gpt', enabled: true, purchasable: true }]
        }))).rejects.toMatchObject({ code: 'ZOVO_PLAN_UNAVAILABLE' });
    });

    it('records the future upstream mapping without submitting an upstream order', () => {
        expect(buildMockUpstreamOrderMapping({
            orderRef: 'ORD-test-123',
            productRef: 'credit250',
            productName: 'Codex Credits 250',
            catalogSource: 'zovocard_mock_catalog',
            catalogVersion: 214,
            serviceFeeUsdMinor: 15,
            isCredit: true,
            requiresActiveSubscription: true
        })).toEqual({
            provider: 'zovocard', product: 'gpt', product_name: 'Codex Credits 250',
            plan: 'credit250', product_ref: 'credit250', client_request_id: 'ORD-test-123',
            order_ref: null, status: 'not_submitted', mode: 'mock',
            catalog_source: 'zovocard_mock_catalog', catalog_version: 214,
            service_fee_usd_minor: 15, is_credit: true, requires_active_subscription: true
        });
    });
});
