'use strict';

/**
 * ZovoCard / SpaceXCard OpenAPI 客户端（第三方 GPT 代充，协议见 spacexcard-openapi / ZovoCard Open API）
 *
 * Base URL:   https://zovocard.com/openapi/v1            （生产）
 *              https://sandbox.zovocard.com/openapi/v1   （沙箱）
 * 认证:       X-API-Key: sk_...
 * 响应包:     { code, msg, data } —— code===0 才成功；失败读 error_code（绝不读 msg）
 * 直充:       POST /gpt-direct/orders（返回 HTTP 202 accepted ≠ 成功，必须轮询到终态）
 *
 * 本模块刻意实现与 gpt-api-client.js 完全相同的导出接口（testConnection / fetchPlans /
 * inspectPay / submitPay / queryOrder / queryTask / queryBalance / maskApiKey /
 * extractOrderId / extractTaskId / extractTopupCode / extractStatus），
 * 因此 server.js 只需切换 require 即可，其余业务逻辑（轮询 / 状态判定）零改动。
 *
 * 关键差异（相对旧 broker）：
 *  - 不传 new_card（PAN/CVC），卡由 ZovoCard 提供；只传客户 credential + plan。
 *  - 建单前需先 POST /gpt-direct/preflight 拿 preflight_token（GPT 必须）。
 *  - 余额用 spendable_balance（账户有 20U 储备金，不能只看 balance）。
 */

const axios = require('axios');

// 可选：通过 SOCKS5 代理固定 ZovoCard 看到的出网 IP（解决白名单 IP 漂移问题）。
// 用法：在 .env / 环境变量设置 ZOVOCARD_PROXY=socks5://user:pass@host:port
// 该代理仅作用于 ZovoCard 调用，不影响本地激活 / BitBrowser 等其他代理配置。
let SocksProxyAgent = null;
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch (_) { SocksProxyAgent = null; }

const DEFAULT_BASE_URL = 'https://zovocard.com/openapi/v1';

// ─── 模拟模式（MOCK）───────────────────────────────────────────────────────
// 开启后所有 ZovoCard 调用返回本地模拟数据，绝不会真实请求 ZovoCard，不会产生扣费。
// 开关来源：
//   1) 当前阶段的安全锁 REQUIRE_ZOVOCARD_MOCK（默认开启，强制 MOCK）
//   2) 后台「第三方代充 API」里的「模拟模式」开关 → 落到 gpt_api_config.mock（经 cfg.mock 传入）
//   3) 环境变量 ZOVOCARD_MOCK=1 / true（无需改库，方便临时测试）
//
// 安全约束：本项目当前阶段必须保持 MOCK。只有显式设置
// REQUIRE_ZOVOCARD_MOCK=0 才允许安全锁不介入；默认值为 1，避免重启或
// 新部署漏配时意外请求真实 ZovoCard。
function isMockLockEnabled() {
    const raw = String(process.env.REQUIRE_ZOVOCARD_MOCK ?? '1').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
}
function isMockMode(cfg) {
    const fromCfg = cfg && (cfg.mock === true || cfg.mock === '1' || cfg.mock === 'true' || cfg.mock === 1);
    const fromEnv = process.env.ZOVOCARD_MOCK === '1' || String(process.env.ZOVOCARD_MOCK).toLowerCase() === 'true';
    return Boolean(isMockLockEnabled() || fromCfg || fromEnv);
}

function mockMeta() {
    return { mock: true, note: 'MOCK 模式：未真实调用 ZovoCard，不会产生任何扣费' };
}

const MOCK_PLANS = [
    { key: 'go', name: 'ChatGPT Go', product: 'gpt', accPlanKey: 'go', enabled: true, purchasable: true, isCredit: false, requiresActiveSubscription: false, serviceFeeUsdMinor: 15 },
    { key: 'plus', name: 'ChatGPT Plus', product: 'gpt', accPlanKey: 'plus', enabled: true, purchasable: true, isCredit: false, requiresActiveSubscription: false, serviceFeeUsdMinor: 15 },
    { key: 'pro_5x', name: 'ChatGPT Pro (5x)', product: 'gpt', accPlanKey: 'pro_5x', enabled: true, purchasable: true, isCredit: false, requiresActiveSubscription: false, serviceFeeUsdMinor: 15 },
    { key: 'pro_20x', name: 'ChatGPT Pro (20x)', product: 'gpt', accPlanKey: 'pro_20x', enabled: true, purchasable: true, isCredit: false, requiresActiveSubscription: false, serviceFeeUsdMinor: 15 },
    { key: 'pro_50x', name: 'ChatGPT Pro (50x)', product: 'gpt', accPlanKey: 'pro_50x', enabled: true, purchasable: true, isCredit: false, requiresActiveSubscription: false, serviceFeeUsdMinor: 15 },
    { key: 'pro_20x_renew', name: 'Pro 20x Renewal (card-attach)', product: 'gpt', accPlanKey: 'pro_20x_renew', enabled: true, purchasable: true, isCredit: false, requiresActiveSubscription: true, serviceFeeUsdMinor: 15 },
    ...[250, 500, 1000, 2500, 5000, 25000].map((credits) => ({
        key: `credit${credits}`,
        name: `Codex Credits ${credits.toLocaleString('en-US')}`,
        product: 'gpt',
        accPlanKey: `credit${credits}`,
        enabled: true,
        purchasable: true,
        isCredit: true,
        requiresActiveSubscription: true,
        serviceFeeUsdMinor: 15
    }))
];

// 模拟订单状态机：每个 orderId 第一次查询返回 processing，之后返回 completed（并清理）
const mockOrderStates = new Map();

function normalizeBaseUrl(raw) {
    const url = String(raw || '').trim().replace(/\/+$/, '');
    if (!url) return '';
    return url;
}

function maskApiKey(key) {
    const k = String(key || '').trim();
    if (!k) return '';
    if (k.length <= 8) return '****';
    return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/**
 * 把 KC 的 session 对象/令牌转成 ZovoCard 的 credential。
 * KC 侧可能传入完整 session JSON 或 { access_token }，这里统一取 access_token。
 */
function buildCredential(session, sessionToken) {
    let tok = null;
    if (session && typeof session === 'object') {
        tok = session.access_token || session.session || session.token || session.session_token || null;
    } else if (typeof session === 'string' && session) {
        tok = session;
    }
    if (!tok && sessionToken) tok = sessionToken;
    return { mode: 'session', session: tok || '' };
}

/**
 * 统一请求封装。始终返回 { success, status?, code?, msg?, data?, error? }
 * data 已经是信封内层（payload.data），方便上层直接读业务字段。
 */
async function request(method, path, cfg, { body, headers: extraHeaders, timeoutMs } = {}) {
    const base = normalizeBaseUrl(cfg?.base_url) || DEFAULT_BASE_URL;
    const apiKey = String(cfg?.api_key || '').trim();
    if (!apiKey) {
        return { success: false, error: '缺少 API Key' };
    }

    const headers = {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(extraHeaders || {})
    };

    try {
        const proxyUrl = process.env.ZOVOCARD_PROXY || '';
        let agent = null;
        if (proxyUrl && SocksProxyAgent) {
            try { agent = new SocksProxyAgent(proxyUrl); } catch (_) { agent = null; }
        }
        const axiosOpts = {
            method,
            url: `${base}${path}`,
            headers,
            data: body == null ? undefined : body,
            validateStatus: () => true,
            timeout: Number(timeoutMs) || 30000,
            // 显式关闭 axios 内置代理逻辑，避免忽略自定义 agent
            proxy: false
        };
        if (agent) {
            axiosOpts.httpAgent = agent;
            axiosOpts.httpsAgent = agent;
        }
        const response = await axios.request(axiosOpts);
        let payload = response.data;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (_) { payload = {}; }
        }
        if (!payload || typeof payload !== 'object') payload = {};

        const code = payload.code;
        const inner = (typeof payload.data !== 'undefined') ? payload.data : payload;
        const ok = code === 0 || (code === undefined && response.status >= 200 && response.status < 300);
        return {
            success: ok,
            status: response.status,
            code,
            msg: payload.msg,
            data: inner,
            error: ok ? undefined : (payload.error_code || payload.msg || `HTTP ${response.status}`)
        };
    } catch (error) {
        let detail = '请求失败';
        if (error?.response?.data) {
            const d = error.response.data;
            detail = (d && typeof d === 'object' && d.error_code) ? d.error_code : (typeof d === 'object' ? JSON.stringify(d).slice(0, 300) : String(d));
        } else if (error?.code === 'ECONNABORTED') {
            detail = '请求超时';
        } else if (error?.message) {
            detail = error.message;
        }
        return { success: false, error: detail };
    }
}

/**
 * 查询可用 GPT 套餐 (GET /gpt-direct/plans?product=gpt)
 * 返回 shape 兼容旧 client：{ success, plans, gptPlans, creditPlans, raw }
 */
async function fetchPlans(cfg) {
    if (isMockMode(cfg)) {
        const plans = MOCK_PLANS.map((row) => ({ ...row }));
        return {
            success: true, status: 200,
            plans,
            gptPlans: plans.filter((row) => !row.isCredit),
            creditPlans: plans.filter((row) => row.isCredit),
            raw: { registry: plans, payment_regions: [] },
            ...mockMeta(),
            catalogVersion: null,
            catalogFixture: 'zovocard-openapi-en-2026-10-08'
        };
    }
    const res = await request('GET', '/gpt-direct/plans?product=gpt', cfg);
    if (!res.success) return { success: false, error: res.error, status: res.status };
    const inner = res.data || {};
    const registry = Array.isArray(inner.registry) ? inner.registry : [];
    const planConfigs = inner.plans && typeof inner.plans === 'object' ? inner.plans : {};
    const normalizePlan = (r) => {
        const key = String(r?.key || '').trim();
        if (!key) return null;
        const accPlanKey = String(r.acc_plan_key || key).trim();
        const config = planConfigs[accPlanKey] || planConfigs[key] || {};
        const fee = Number(r.service_fee_usd_minor ?? config.service_fee_usd_minor ?? config.serviceFeeUsdMinor);
        return {
            key,
            name: String(r.label || r.name || key).trim(),
            product: String(r.product || 'gpt').trim().toLowerCase(),
            accPlanKey,
            enabled: config.enabled === true,
            purchasable: r.purchasable === true,
            isCredit: r.is_credit === true,
            requiresActiveSubscription: r.requires_active_subscription === true,
            serviceFeeUsdMinor: Number.isSafeInteger(fee) && fee >= 0 ? fee : null,
            paymentRegions: Array.isArray(inner.payment_regions)
                ? inner.payment_regions.map((region) => String(region?.country || '').trim().toUpperCase()).filter(Boolean).slice(0, 32)
                : [],
            raw: r
        };
    };
    const catalog = registry.map(normalizePlan).filter(Boolean);
    const gpt = catalog.filter((r) => r.product === 'gpt' && !r.isCredit);
    const credit = catalog.filter((r) => r.product === 'gpt' && r.isCredit);
    return {
        success: true,
        status: res.status,
        plans: [...gpt, ...credit],
        gptPlans: gpt,
        creditPlans: credit,
        catalogVersion: inner.version ?? null,
        raw: inner
    };
}

/**
 * 建单前验证 Session（POST /gpt-direct/preflight）
 * 对 ZovoCard 而言 preflight 会校验登录态与当前套餐，并产出 preflight_token，
 * 天然替代旧 broker 的 /pay/inspect 本地检查。
 */
async function inspectPay(cfg, { planKey, session, sessionToken }) {
    if (isMockMode(cfg)) {
        return { success: true, status: 200, data: { mock: 'preflight-ok' }, error: null, reason: null, upstreamStatus: null, ...mockMeta() };
    }
    const credential = buildCredential(session, sessionToken);
    const body = {
        product: 'gpt',
        plan: planKey || 'plus',
        credential,
        payment_country: (cfg?.country || 'PH').toUpperCase(),
        payment_currency: (cfg?.currency || 'PHP').toUpperCase()
    };
    const res = await request('POST', '/gpt-direct/preflight', cfg, { body, timeoutMs: 30000 });
    if (!res.success) {
        return {
            success: false,
            status: res.status,
            data: res.data,
            error: res.error || 'session_invalid',
            reason: res.error,
            upstreamStatus: null
        };
    }
    return {
        success: true,
        status: res.status,
        data: res.data,
        error: null,
        reason: null,
        upstreamStatus: null
    };
}

/**
 * 提交 GPT 代充 (POST /gpt-direct/preflight + POST /gpt-direct/orders)
 * 注意：ZovoCard 不接收 new_card / cardId / proxy，这些字段被忽略。
 * @returns { success, orderId?, taskId?, data, error? }
 */
async function submitPay(cfg, { planKey, session, sessionToken, country, currency, newCard, cardId, cvc, proxy, clientRef, idempotencyKey }) {
    if (isMockMode(cfg)) {
        const idem = idempotencyKey || clientRef || `kc-${Date.now()}`;
        const orderId = `MOCK-${idem}`;
        return {
            success: true, status: 202,
            orderId, taskId: null, id: orderId,
            alreadySubmitted: false, topupCode: null,
            data: { order_id: orderId, status: 'pending', mock: true },
            ...mockMeta()
        };
    }
    const credential = buildCredential(session, sessionToken);
    const paymentCountry = (country || cfg?.country || 'PH').toUpperCase();
    const paymentCurrency = (currency || cfg?.currency || 'PHP').toUpperCase();

    // 1) preflight（GPT 建单必须）
    const pf = await request('POST', '/gpt-direct/preflight', cfg, {
        body: { product: 'gpt', plan: planKey, credential, payment_country: paymentCountry, payment_currency: paymentCurrency },
        timeoutMs: 30000
    });
    if (!pf.success) {
        return { success: false, status: pf.status, error: pf.error };
    }
    // preflight 返回 data 可能是 { preflight_token, ... } 或包裹一层
    const pfInner = pf.data || {};
    const preflightToken =
        pfInner.preflight_token ||
        (pfInner.data && pfInner.data.preflight_token) ||
        null;

    // 2) 建单（返回 HTTP 202 accepted，不是成功）
    const body = {
        product: 'gpt',
        plan: planKey,
        credential,
        client_request_id: idempotencyKey || clientRef || `kc-${Date.now()}`,
        payment_country: paymentCountry,
        payment_currency: paymentCurrency
    };
    if (preflightToken) body.preflight_token = preflightToken;

    const res = await request('POST', '/gpt-direct/orders', cfg, { body, timeoutMs: 60000 });
    if (!res.success) {
        return { success: false, status: res.status, error: res.error, data: res.data };
    }

    const orderId = extractOrderId(res.data);
    if (!orderId) {
        return { success: false, status: res.status, error: `代充提交成功但未返回订单号: ${JSON.stringify(res.data).slice(0, 300)}` };
    }

    return {
        success: true,
        status: res.status,
        orderId,
        taskId: null,
        id: orderId,
        alreadySubmitted: false,
        topupCode: null,
        data: res.data
    };
}

function extractId(data) {
    if (!data || typeof data !== 'object') return null;
    return data.id ?? data.order_id ?? data.task_id ?? data._id ?? null;
}

function extractOrderId(data) {
    if (!data || typeof data !== 'object') return null;
    return (
        data.order?.order_id ??
        data.order?.id ??
        data.order_id ??
        data.orderId ??
        data.id ??
        data.pay_order_id ??
        null
    );
}

function extractTaskId(data) {
    // ZovoCard 直充无独立 task 概念，返回 null
    return null;
}

function extractTopupCode(data) {
    // ZovoCard 订单无 topup_code
    if (!data || typeof data !== 'object') return null;
    const code = data.topup_code ?? data.order?.topup_code ?? null;
    return code == null || String(code).trim() === '' ? null : String(code).trim();
}

/**
 * 查询单笔代充订单状态 (GET /gpt-direct/orders/{order_id})
 */
async function queryOrder(cfg, orderId) {
    if (isMockMode(cfg)) {
        // 段C6 测试钩子：ZOVOCARD_MOCK_FAIL=1 时让订单在第二次轮询时返回 failed，
        // 用于验证「失败态进终态后，前台仍能看到失败原因」（终态短路持久化）。
        // 仅在 MOCK 模式下生效，真实链路绝不会走到这里。
        if (process.env.ZOVOCARD_MOCK_FAIL === '1' || String(process.env.ZOVOCARD_MOCK_FAIL).toLowerCase() === 'true') {
            let fst = mockOrderStates.get(orderId) || 'pending';
            if (fst === 'pending') {
                mockOrderStates.set(orderId, 'failing');
                fst = 'processing';
            } else {
                mockOrderStates.delete(orderId);
                fst = 'failed';
            }
            if (fst === 'failed') {
                return {
                    success: true, status: 200,
                    data: {
                        order_id: orderId, status: 'failed',
                        result: { ok: false, error: '上游账号已被封禁（MOCK 注入）' },
                        mock: true
                    },
                    rawStatus: 'failed', ...mockMeta()
                };
            }
            return {
                success: true, status: 200,
                data: { order_id: orderId, status: fst, result: { ok: true }, topup_code: 'MOCK-TOPUP', mock: true },
                rawStatus: fst, ...mockMeta()
            };
        }

        let st = mockOrderStates.get(orderId) || 'pending';
        if (st === 'pending') {
            mockOrderStates.set(orderId, 'completed');
            st = 'processing';
        } else {
            mockOrderStates.delete(orderId);
            st = 'completed';
        }
        return {
            success: true, status: 200,
            data: { order_id: orderId, status: st, result: { ok: true }, topup_code: 'MOCK-TOPUP', mock: true },
            rawStatus: st, ...mockMeta()
        };
    }
    if (!orderId) {
        return { success: false, error: '缺少订单号' };
    }
    const res = await request('GET', `/gpt-direct/orders/${encodeURIComponent(orderId)}`, cfg);
    if (!res.success) return { success: false, status: res.status, error: res.error, rawStatus: '' };
    const order = res.data || {};
    return {
        success: true,
        status: res.status,
        data: order,
        rawStatus: order.status || ''
    };
}

/**
 * 查询任务状态 (GET /tasks/{task_id})
 * ZovoCard 直充用订单轮询即可，这里直接复用订单端点（保持接口兼容）。
 */
async function queryTask(cfg, taskId) {
    if (isMockMode(cfg)) {
        return queryOrder(cfg, taskId);
    }
    if (!taskId) {
        return { success: false, error: '缺少任务号', rawStatus: '' };
    }
    return queryOrder(cfg, taskId);
}

/**
 * 查询账户余额 (GET /balance) —— 用 spendable_balance
 */
async function queryBalance(cfg) {
    if (isMockMode(cfg)) {
        return {
            success: true, status: 200,
            data: { spendable_balance: 999.99, balance: 999.99, mock: true },
            credits: null, balance: 999.99, balanceUsd: '999.99', ...mockMeta()
        };
    }
    const res = await request('GET', '/balance', cfg);
    if (!res.success) return { success: false, error: res.error };
    const b = res.data || {};
    const spendable = (b.spendable_balance != null) ? b.spendable_balance : (b.balance != null ? b.balance : 0);
    return {
        success: true,
        status: res.status,
        data: b,
        credits: null,
        balance: spendable,
        balanceUsd: String(spendable)
    };
}

function extractStatus(data) {
    if (!data || typeof data !== 'object') return '';
    const resultStatus = data.result && typeof data.result === 'object' ? data.result.status : '';
    if (resultStatus) return resultStatus;
    const outer = data.status ?? data.state ?? data.order?.status ?? data.task?.status ?? '';
    return outer;
}

/**
 * 测试连接：查询套餐 + 余额，返回摘要
 */
async function testConnection(cfg) {
    if (isMockMode(cfg)) {
        return {
            success: true,
            message: 'MOCK 模式：模拟连接成功（未真实调用 ZovoCard，无扣费）',
            plans: MOCK_PLANS, gptPlans: MOCK_PLANS, creditPlans: [],
            balance: { spendable_balance: 999.99 }
        };
    }
    const [plansRes, balanceRes] = await Promise.all([
        fetchPlans(cfg),
        queryBalance(cfg)
    ]);

    if (!plansRes.success) {
        return { success: false, error: `套餐查询失败: ${plansRes.error}` };
    }

    const messages = [];
    if (plansRes.success) {
        messages.push(`套餐 ${Array.isArray(plansRes.plans) ? plansRes.plans.length : 0} 个`);
    }
    if (balanceRes.success) {
        const b = balanceRes.data || {};
        const balance = b.spendable_balance != null ? b.spendable_balance : (b.balance != null ? b.balance : '');
        if (balance !== '') {
            messages.push(`可用余额 ${balance}`);
        }
    }

    return {
        success: true,
        message: `API 连接成功（${messages.join('，')}）`,
        plans: plansRes.plans || [],
        gptPlans: plansRes.gptPlans || [],
        creditPlans: plansRes.creditPlans || [],
        balance: balanceRes.success ? balanceRes.data : null
    };
}

module.exports = {
    DEFAULT_BASE_URL,
    isMockMode,
    isMockLockEnabled,
    normalizeBaseUrl,
    maskApiKey,
    request,
    fetchPlans,
    inspectPay,
    submitPay,
    queryOrder,
    queryTask,
    queryBalance,
    testConnection,
    extractOrderId,
    extractTaskId,
    extractTopupCode,
    extractStatus
};
