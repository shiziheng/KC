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

// ─── 订单状态机归一（文档 §6.18.5）──────────────────────────────────────────
// 终态：completed=成功；declined / failed_precharge / cancelled=失败。
// 其余（queued / awaiting_card / funding_pending / dispatching / running /
// requires_action / pending / plus_paid）一律为「进行中」，review 为「人工对账中」。
// ★ 绝不把进行中或 review 判为失败 ★（自动换卡中途 decline 会回到 queued）。
const ORDER_STATE_SUCCESS = new Set(['completed']);
const ORDER_STATE_FAILED = new Set(['declined', 'failed_precharge', 'cancelled']);
const ORDER_STATE_REVIEW = new Set(['review']);
const ORDER_STATE_INFLIGHT = new Set(['queued', 'awaiting_card', 'funding_pending', 'dispatching', 'running', 'requires_action', 'pending', 'plus_paid']);

/**
 * 把上游原始 status 归一为 'success' | 'failed' | 'inflight' | 'review'。
 * 未知状态一律归为 inflight（非终态）——宁可继续轮询，也不误判失败。
 */
function normalizeOrderState(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return 'inflight';
    if (ORDER_STATE_SUCCESS.has(s)) return 'success';
    if (ORDER_STATE_FAILED.has(s)) return 'failed';
    if (ORDER_STATE_REVIEW.has(s)) return 'review';
    return 'inflight';
}

function isTerminalOrderState(raw) {
    return normalizeOrderState(raw) !== 'inflight';
}

// ─── 错误分类（文档 §3 / §A.4；★绝不按 msg 文本分支★）──────────────────────
// retryable=true 表示可退避重试；action: retry / user_action / terminal / conflict。
const RETRYABLE_ERROR_CODES = new Set([
    'channel_unavailable', 'internal_error', 'upstream_unavailable',
    'GPT_DIRECT_UNAVAILABLE', 'GPT_DIRECT_PAUSED', 'GPT_PREFLIGHT_RATE_LIMITED'
]);
const USER_ACTION_ERROR_CODES = new Set([
    'INSUFFICIENT_BALANCE', 'insufficient_balance', 'GPT_PRICE_UNCONFIRMED',
    'GPT_DIRECT_ACCESS_DENIED', 'RECHARGE_REQUIRED'
]);
const TERMINAL_ERROR_CODES = new Set([
    'GPT_RENEW_TARGET_NOT_PRO', 'GPT_RENEW_SUBSCRIPTION_EXPIRED', 'GPT_SESSION_INVALID', 'CLAUDE_SESSION_INVALID',
    'GPT_PLAN_ALREADY_ACTIVE', 'GPT_CREDIT_REQUIRES_SUBSCRIPTION', 'GPT_CREDIT_DISABLED',
    'DIRECT_PRODUCT_DISABLED', 'EXTERNAL_CARD_DISABLED', 'PRECHECK_REJECTED',
    'INVALID_REQUEST', 'invalid_argument', 'not_found', 'forbidden', 'FORBIDDEN',
    'ACCOUNT_UNAVAILABLE', 'request_failed'
]);

function classifyError(errorCode, httpCode) {
    const code = String(errorCode || '').trim();
    const http = Number(httpCode) || 0;
    if (RETRYABLE_ERROR_CODES.has(code)) return { retryable: true, action: 'retry' };
    if (USER_ACTION_ERROR_CODES.has(code)) return { retryable: false, action: 'user_action' };
    if (TERMINAL_ERROR_CODES.has(code)) return { retryable: false, action: 'terminal' };
    if (http === 429 || http === 500 || http === 503) return { retryable: true, action: 'retry' };
    if (http === 409) return { retryable: false, action: 'conflict' };
    if (http === 401 || http === 403 || http === 404) return { retryable: false, action: 'terminal' };
    if (http >= 400) return { retryable: false, action: 'terminal' };
    return { retryable: false, action: '' };
}

// ─── MOCK 订单状态机（照真状态机产样本，可用环境变量注入场景）──────────────
// ZOVOCARD_MOCK_SEQUENCE=queued,dispatching,completed  显式序列（优先）
// ZOVOCARD_MOCK_FAIL=1          → queued,dispatching,declined（真实失败终态）
// ZOVOCARD_MOCK_REVIEW=1        → queued,review（人工对账，绝不判失败）
const DEFAULT_MOCK_ORDER_SEQUENCE = ['queued', 'awaiting_card', 'completed'];

function isTruthyEnv(name) {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function mockOrderSequence() {
    const custom = String(process.env.ZOVOCARD_MOCK_SEQUENCE || '').trim();
    if (custom) {
        const seq = custom.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (seq.length) return seq;
    }
    if (isTruthyEnv('ZOVOCARD_MOCK_FAIL')) return ['queued', 'dispatching', 'declined'];
    if (isTruthyEnv('ZOVOCARD_MOCK_REVIEW')) return ['queued', 'review'];
    return DEFAULT_MOCK_ORDER_SEQUENCE.slice();
}

// account-orders（§6.18.5b）MOCK 样本：覆盖成功 / 失败 / review 三种终态语义
const MOCK_ACCOUNT_ORDERS = [
    { order_id: 981, source: 'mall', product: 'gpt', plan: 'plus', account_email: 'us***@example.com', status: 'completed', stage: 'completed', quoted_amount_minor: 98000, final_amount_minor: 98214, currency: 'PHP', card_id: 456, card_last_four: '1234', created_at: '2026-09-24T10:00:00Z', updated_at: '2026-09-24T10:05:00Z', completed_at: '2026-09-24T10:05:00Z' },
    { order_id: 982, source: 'api', product: 'gpt', plan: 'pro_20x', account_email: 'us***@example.com', status: 'declined', stage: 'declined', quoted_amount_minor: 98000, final_amount_minor: null, currency: 'PHP', card_id: 457, card_last_four: '5678', created_at: '2026-09-24T10:00:00Z', updated_at: '2026-09-24T10:06:00Z', completed_at: null },
    { order_id: 983, source: 'cdk', product: 'gpt', plan: 'plus', account_email: 'us***@example.com', status: 'review', stage: 'review', quoted_amount_minor: 98000, final_amount_minor: null, currency: 'PHP', card_id: 458, card_last_four: '9012', created_at: '2026-09-24T10:00:00Z', updated_at: '2026-09-24T10:07:00Z', completed_at: null }
];
const MOCK_ACCOUNT_ORDERS_SYNC_UNTIL = '2026-09-24T10:08:00Z';

// Idempotency-Key 允许 A-Za-z0-9._:-，1–80 字符（§4）
function sanitizeIdempotencyKey(raw) {
    const cleaned = String(raw || '').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 80);
    return cleaned || `kc-${Date.now()}`;
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

// MOCK：升级报价样本（可注入场景，用于验证「同套餐不可升级 / 跨级可升级」两条路径）——
//   ZOVOCARD_MOCK_UPGRADE=none          → 返回空 quotes（模拟「同套餐已开通 / 无可用报价」）
//   ZOVOCARD_MOCK_UPGRADE_AMOUNT_MINOR  → 报价金额（minor，默认 500000）
//   ZOVOCARD_MOCK_UPGRADE_CURRENCY      → 报价币种（默认 PHP：Zovo 升级差额按「账户发票币种」）
//   ZOVOCARD_MOCK_UPGRADE_EXPONENT      → 小数位指数（默认 2；JPY=0，★不可一律 ÷100★）
//   ZOVOCARD_MOCK_CURRENT_PLAN          → 当前套餐（默认 'plus'）
// 默认夹具：PHP 5000.00（minor=500000, exp=2）—— 与 MOCK 汇率表（1 PHP = 0.02 USD）配合得到
// 「折 USD $100.00」的确定性成本，便于计价/结算断言（v2.20.0）。
function mockUpgradeQuoteList(planKey) {
    const mode = String(process.env.ZOVOCARD_MOCK_UPGRADE || '').trim().toLowerCase();
    if (mode === 'none') return [];
    const target = String(planKey || process.env.ZOVOCARD_MOCK_UPGRADE_PLAN || 'pro_20x').trim();
    const current = String(process.env.ZOVOCARD_MOCK_CURRENT_PLAN || 'plus').trim();
    const currency = String(process.env.ZOVOCARD_MOCK_UPGRADE_CURRENCY || 'PHP').trim().toUpperCase() || 'PHP';
    const expRaw = Number(process.env.ZOVOCARD_MOCK_UPGRADE_EXPONENT);
    const exponent = Number.isFinite(expRaw) ? expRaw : 2;
    const amount = Number(process.env.ZOVOCARD_MOCK_UPGRADE_AMOUNT_MINOR || 500000);
    const amt = Number.isFinite(amount) && amount >= 0 ? amount : 500000;
    return [{
        plan: target,
        current_plan: current,
        available: true,
        currency: currency,
        amount_minor: amt,
        minor_unit_exponent: exponent,
        funding_usd_minor: Math.round(amt * 1.1),
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        preflight_token: 'MOCKUP-' + target + '-' + Date.now().toString(36)
    }];
}

// v2.20.0 · MOCK：升级订单终态回传的「实付金额」（结算口径）。
// 默认 450000 minor = PHP 4500.00（折 USD $90.00），低于报价（500000）→ 可稳定验证「按实付结算 → 多退」。
function mockUpgradeFinalMinor() {
    const n = Number(process.env.ZOVOCARD_MOCK_UPGRADE_FINAL_MINOR || 450000);
    return Number.isFinite(n) && n > 0 ? n : 450000;
}
function mockUpgradeCurrency() {
    return String(process.env.ZOVOCARD_MOCK_UPGRADE_CURRENCY || 'PHP').trim().toUpperCase() || 'PHP';
}

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
 * 统一请求封装。始终返回：
 *   { ok, success, status, httpCode, code, msg, errorCode, retryable, errorAction, accepted, data, error, raw }
 * data 已经是信封内层（payload.data），方便上层直接读业务字段。
 * ★ 失败一律读 error_code（绝不按 msg 文本分支）；HTTP 202 = accepted（非成功非失败）。
 * base_url / api_key 以后台（DB）配置 cfg 优先，环境变量 ZOVOCARD_BASE_URL / ZOVOCARD_API_KEY 作兜底。
 */
async function request(method, path, cfg, { body, headers: extraHeaders, timeoutMs } = {}) {
    const base = normalizeBaseUrl(cfg?.base_url) || normalizeBaseUrl(process.env.ZOVOCARD_BASE_URL) || DEFAULT_BASE_URL;
    const apiKey = String(cfg?.api_key || process.env.ZOVOCARD_API_KEY || '').trim();
    if (!apiKey) {
        const cls = classifyError('', 401);
        return { ok: false, success: false, error: '缺少 API Key', errorCode: 'MISSING_API_KEY', retryable: cls.retryable, errorAction: 'terminal' };
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

        const httpCode = Number(response.status) || 0;
        const code = payload.code;
        const inner = (typeof payload.data !== 'undefined') ? payload.data : payload;
        const ok = code === 0 || (code === undefined && httpCode >= 200 && httpCode < 300);
        const errorCode = ok ? undefined : (payload.error_code || undefined);
        const cls = ok ? { retryable: false, action: '' } : classifyError(errorCode, httpCode);
        return {
            ok,
            success: ok,
            status: httpCode,
            httpCode,
            code,
            msg: payload.msg,
            errorCode,
            retryable: cls.retryable,
            errorAction: cls.action,
            accepted: httpCode === 202,
            data: inner,
            raw: payload,
            error: ok ? undefined : (errorCode || payload.msg || `HTTP ${httpCode}`)
        };
    } catch (error) {
        const httpCode = Number(error?.response?.status) || 0;
        const d = error?.response?.data;
        let errorCode = undefined;
        let detail = '请求失败';
        if (d && typeof d === 'object') {
            errorCode = d.error_code || undefined;
            detail = errorCode || d.msg || JSON.stringify(d).slice(0, 300);
        } else if (typeof d === 'string' && d) {
            detail = d;
        } else if (error?.code === 'ECONNABORTED') {
            detail = '请求超时';
        } else if (error?.message) {
            detail = error.message;
        }
        // 网络/超时类无 HTTP 状态码：一律视为可退避重试，绝不判为确定性失败
        const cls = httpCode ? classifyError(errorCode, httpCode) : { retryable: true, action: 'retry' };
        return {
            ok: false,
            success: false,
            status: httpCode,
            httpCode,
            errorCode,
            retryable: cls.retryable,
            errorAction: cls.action,
            error: detail
        };
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
    if (!res.success) return { ok: false, success: false, error: res.error, status: res.status, httpCode: res.httpCode, errorCode: res.errorCode, retryable: res.retryable, errorAction: res.errorAction };
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
            ok: false,
            success: false,
            status: res.status,
            httpCode: res.httpCode,
            errorCode: res.errorCode,
            retryable: res.retryable,
            errorAction: res.errorAction,
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
 * 已有订阅的升级报价 (POST /gpt-direct/upgrade-quotes)。
 * 依据文档：先 preflight 拿 preflight_token → 仅用该 token 取 quotes[]；
 * 取 plan===目标 && available 的一项，用其「新 preflight_token + currency」提交订单。
 * 报价 ≤5 分钟，绑定「用户+账号+目标+金额+币种」；同级/更高套餐拿不到可付报价。
 * @returns { ok, success, quotes:[{plan,current_plan,available,currency,amount_minor,minor_unit_exponent,expires_at,preflight_token}] }
 */
async function upgradeQuotes(cfg, { preflightToken, planKey } = {}) {
    if (isMockMode(cfg)) {
        const quotes = mockUpgradeQuoteList(planKey);
        return { ok: true, success: true, status: 200, httpCode: 200, quotes, data: { quotes }, ...mockMeta() };
    }
    const token = String(preflightToken || '').trim();
    if (!token) {
        return { ok: false, success: false, errorCode: 'INVALID_REQUEST', retryable: false, errorAction: 'terminal', error: '缺少 preflight_token' };
    }
    const res = await request('POST', '/gpt-direct/upgrade-quotes', cfg, { body: { preflight_token: token }, timeoutMs: 30000 });
    if (!res.success) {
        return { ok: false, success: false, status: res.status, httpCode: res.httpCode, errorCode: res.errorCode, retryable: res.retryable, errorAction: res.errorAction, error: res.error, data: res.data };
    }
    const inner = res.data || {};
    const quotes = Array.isArray(inner.quotes) ? inner.quotes : (Array.isArray(inner) ? inner : []);
    return { ok: true, success: true, status: res.status, httpCode: res.httpCode, quotes, data: inner };
}

/**
 * 提交 GPT 代充 (POST /gpt-direct/preflight + POST /gpt-direct/orders)
 * 建单卡字段（§6.18.0 / §6.18.0.1）：card_id 与 raw_card 二选一（都传会 400 INVALID_REQUEST）。
 * 默认两者都不传 → 走平台卡池自动选卡；仅当显式传入 cardId 时才带 card_id。
 * new_card / cvc / proxy 为旧 broker 兼容参数，ZovoCard 侧忽略。
 * 自动换卡：保留文档默认（开启、最多 2 次），因此**不发** no_auto_card_switch。
 * @returns { ok, success, orderId?, taskId?, data, error?, errorCode?, httpCode?, retryable? }
 */
async function submitPay(cfg, { planKey, session, sessionToken, country, currency, newCard, cardId, rawCard, cvc, proxy, clientRef, idempotencyKey, pricingVersion, preflightToken, paymentMode }) {
    if (isMockMode(cfg)) {
        const idem = idempotencyKey || clientRef || `kc-${Date.now()}`;
        const orderId = `MOCK-${idem}`;
        return {
            ok: true, success: true, status: 202, httpCode: 202, accepted: true,
            orderId, taskId: null, id: orderId,
            alreadySubmitted: false, topupCode: null,
            data: { order_id: orderId, status: 'queued', mock: true },
            ...mockMeta()
        };
    }
    const hasCardId = cardId !== undefined && cardId !== null && String(cardId).trim() !== '';
    const hasRawCard = rawCard !== undefined && rawCard !== null && String(rawCard).trim() !== '';
    // 二选一：同时提供会被上游 400 INVALID_REQUEST 拒绝，这里在本地先行拦截
    if (hasCardId && hasRawCard) {
        return {
            ok: false, success: false, httpCode: 400, status: 400,
            errorCode: 'INVALID_REQUEST', retryable: false, errorAction: 'terminal',
            error: 'card_id 与 raw_card 只能二选一（同时提供会被上游拒绝）'
        };
    }

    const credential = buildCredential(session, sessionToken);
    const paymentCountry = (country || cfg?.country || 'PH').toUpperCase();
    const paymentCurrency = (currency || cfg?.currency || 'PHP').toUpperCase();
    const clientRequestId = sanitizeIdempotencyKey(idempotencyKey || clientRef || `kc-${Date.now()}`);

    // 0) 读取商品目录 version（Trap 4：配置 version 变化后需重跑 preflight 并带最新 pricing_version）
    let pricing = (pricingVersion === undefined || pricingVersion === null) ? null : Number(pricingVersion);
    try {
        const plans = await fetchPlans(cfg);
        if (plans && plans.success && plans.catalogVersion !== null && plans.catalogVersion !== undefined) {
            pricing = Number(plans.catalogVersion);
        }
    } catch (_) { /* 目录读取失败不阻断：缺 pricing_version 时上游按 latest 处理 */ }

    // 1) preflight（GPT 建单必须）；升级路径下由调用方传入 upgrade-quotes 返回的**新 preflight_token**，跳过内部 preflight
    let pfToken = String(preflightToken || '').trim() || null;
    if (!pfToken) {
        const pf = await request('POST', '/gpt-direct/preflight', cfg, {
            body: { product: 'gpt', plan: planKey, credential, payment_country: paymentCountry, payment_currency: paymentCurrency },
            timeoutMs: 30000
        });
        if (!pf.success) {
            return {
                ok: false, success: false, status: pf.status, httpCode: pf.httpCode,
                errorCode: pf.errorCode, retryable: pf.retryable, errorAction: pf.errorAction,
                error: pf.error, data: pf.data
            };
        }
        // preflight 返回 data 可能是 { preflight_token, ... } 或包裹一层
        const pfInner = pf.data || {};
        pfToken = pfInner.preflight_token || (pfInner.data && pfInner.data.preflight_token) || null;
    }

    // 2) 建单（POST /gpt-direct/orders，返回 HTTP 202 accepted，不是成功）
    const body = {
        product: 'gpt',
        plan: planKey,
        credential,
        client_request_id: clientRequestId,
        payment_country: paymentCountry,
        payment_currency: paymentCurrency
    };
    if (pfToken) body.preflight_token = pfToken;
    if (paymentMode) body.payment_mode = paymentMode;
    if (pricing !== null && Number.isSafeInteger(pricing)) body.pricing_version = pricing;
    // 卡字段二选一：默认不传（自动选卡），显式传 card_id 时带上
    if (hasCardId) body.card_id = Number(cardId);
    else if (hasRawCard) body.raw_card = String(rawCard);
    // 不传 no_auto_card_switch → 保留平台默认（自动换卡开、最多 2 次）

    const res = await request('POST', '/gpt-direct/orders', cfg, {
        body,
        // §4 幂等：写操作必须带 Idempotency-Key，重试复用同一 key
        headers: { 'Idempotency-Key': clientRequestId },
        timeoutMs: 60000
    });
    if (!res.success) {
        return {
            ok: false, success: false, status: res.status, httpCode: res.httpCode,
            errorCode: res.errorCode, retryable: res.retryable, errorAction: res.errorAction,
            error: res.error, data: res.data
        };
    }

    const orderId = extractOrderId(res.data);
    if (!orderId) {
        return {
            ok: false, success: false, status: res.status, httpCode: res.httpCode,
            errorCode: 'MALFORMED_ORDER_RESPONSE', retryable: false, errorAction: 'terminal',
            error: `代充提交成功但未返回订单号: ${JSON.stringify(res.data).slice(0, 300)}`
        };
    }

    return {
        ok: true,
        success: true,
        status: res.status,
        httpCode: res.httpCode,
        accepted: res.accepted === true,
        orderId,
        taskId: null,
        id: orderId,
        alreadySubmitted: false,
        topupCode: null,
        pricingVersion: pricing,
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
 * rawStatus = 上游原始 status；state = normalizeOrderState(rawStatus) 归一结果。
 *
 * MOCK 照真状态机产样本（可用 ZOVOCARD_MOCK_SEQUENCE / ZOVOCARD_MOCK_FAIL /
 * ZOVOCARD_MOCK_REVIEW 注入场景），使测试覆盖真机语义（进行中 / review / 失败终态）。
 */
async function queryOrder(cfg, orderId) {
    if (isMockMode(cfg)) {
        const seq = mockOrderSequence();
        const idx = Math.min(Number(mockOrderStates.get(orderId) || 0), seq.length - 1);
        const st = seq[idx];
        mockOrderStates.set(orderId, idx + 1);
        const state = normalizeOrderState(st);
        const result = state === 'success'
            ? { ok: true }
            : (state === 'failed' ? { ok: false, error: '上游代充失败（MOCK 注入）' } : { ok: true, pending: true });
        return {
            ok: true, success: true, status: 200, httpCode: 200,
            data: {
                order_id: orderId,
                status: st,
                result,
                // v2.20.0 · 实付金额（含币种/小数位）——升级单结算口径；★仅终态成功回传，且不以金额判成功★
                ...(state === 'success' ? {
                    final_amount_minor: mockUpgradeFinalMinor(),
                    currency: mockUpgradeCurrency(),
                    minor_unit_exponent: 2
                } : {}),
                ...(state === 'success' ? { topup_code: 'MOCK-TOPUP' } : {}),
                mock: true
            },
            rawStatus: st,
            state,
            ...mockMeta()
        };
    }
    if (!orderId) {
        return { ok: false, success: false, error: '缺少订单号', rawStatus: '', state: 'inflight' };
    }
    const res = await request('GET', `/gpt-direct/orders/${encodeURIComponent(orderId)}`, cfg);
    if (!res.success) {
        return {
            ok: false, success: false, status: res.status, httpCode: res.httpCode,
            errorCode: res.errorCode, retryable: res.retryable, errorAction: res.errorAction,
            error: res.error, rawStatus: '', state: 'inflight'
        };
    }
    const order = res.data || {};
    const rawStatus = order.status || '';
    return {
        ok: true,
        success: true,
        status: res.status,
        httpCode: res.httpCode,
        data: order,
        rawStatus,
        state: normalizeOrderState(rawStatus)
    };
}

/**
 * 账户级只读订单同步（§6.18.5b GET /gpt-direct/account-orders）
 *
 * 游标分页（不是 page）：首个请求带筛选 source/updated_after/page_size；
 * 后续请求只带 cursor（+ 可选 page_size），不再带 source/updated_after；has_more=false 结束。
 * 升序 (updated_at, order_id)；调用方用 order_id upsert、忽略更旧的 updated_at。
 */
async function listAccountOrders(cfg, { source, updated_after, cursor, page_size } = {}) {
    const cursorText = cursor === undefined || cursor === null ? '' : String(cursor).trim();
    const hasCursor = cursorText !== '';
    const hasSource = source !== undefined && source !== null && String(source).trim() !== '';
    const hasUpdatedAfter = updated_after !== undefined && updated_after !== null && String(updated_after).trim() !== '';
    const pageSize = page_size === undefined || page_size === null || page_size === ''
        ? 20
        : Math.max(1, Math.min(100, Number(page_size) || 20));

    if (isMockMode(cfg)) {
        // 模拟游标语义：后续请求不得再带筛选参数（与真机一致，违反则 400）
        if (hasCursor) {
            if (hasSource || hasUpdatedAfter) {
                return { ok: false, success: false, httpCode: 400, status: 400, errorCode: 'invalid_argument', retryable: false, errorAction: 'terminal', error: 'cursor 后续请求不得再带 source/updated_after' };
            }
            if (!/^\d+$/.test(cursorText)) {
                return { ok: false, success: false, httpCode: 400, status: 400, errorCode: 'invalid_argument', retryable: false, errorAction: 'terminal', error: '非法 cursor' };
            }
        }
        if (hasSource && !['mall', 'api', 'cdk'].includes(String(source))) {
            return { ok: false, success: false, httpCode: 400, status: 400, errorCode: 'invalid_argument', retryable: false, errorAction: 'terminal', error: 'source 只能为 mall|api|cdk' };
        }
        if (hasUpdatedAfter && Number.isNaN(Date.parse(String(updated_after)))) {
            return { ok: false, success: false, httpCode: 400, status: 400, errorCode: 'invalid_argument', retryable: false, errorAction: 'terminal', error: 'updated_after 必须是带时区的 RFC3339 时间戳' };
        }
        let rows = MOCK_ACCOUNT_ORDERS.map((r) => ({ ...r }));
        if (!hasCursor && hasSource) rows = rows.filter((r) => r.source === String(source));
        if (!hasCursor && hasUpdatedAfter) rows = rows.filter((r) => Date.parse(r.updated_at) >= Date.parse(String(updated_after)));
        const offset = hasCursor ? Number(cursorText) : 0;
        const page = rows.slice(offset, offset + pageSize);
        const hasMore = offset + pageSize < rows.length;
        return {
            ok: true, success: true, status: 200, httpCode: 200,
            list: page,
            next_cursor: hasMore ? String(offset + pageSize) : '',
            has_more: hasMore,
            sync_until: MOCK_ACCOUNT_ORDERS_SYNC_UNTIL,
            data: { list: page, next_cursor: hasMore ? String(offset + pageSize) : '', has_more: hasMore, sync_until: MOCK_ACCOUNT_ORDERS_SYNC_UNTIL },
            ...mockMeta()
        };
    }

    const params = new URLSearchParams();
    if (hasCursor) {
        params.set('cursor', cursorText);
        params.set('page_size', String(pageSize));
    } else {
        if (hasSource) params.set('source', String(source));
        if (hasUpdatedAfter) params.set('updated_after', String(updated_after));
        params.set('page_size', String(pageSize));
    }
    const res = await request('GET', `/gpt-direct/account-orders?${params.toString()}`, cfg);
    if (!res.success) return res;
    const inner = res.data || {};
    const list = Array.isArray(inner.list) ? inner.list : [];
    return {
        ok: true,
        success: true,
        status: res.status,
        httpCode: res.httpCode,
        list,
        next_cursor: String(inner.next_cursor || ''),
        has_more: inner.has_more === true,
        sync_until: String(inner.sync_until || ''),
        data: inner
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
 * 测试连接：查询套餐 + 余额，返回摘要。
 * ★ 必须诚实区分「已真实连通」与「当前为 MOCK、未真实连通」：
 *   - 被安全锁（REQUIRE_ZOVOCARD_MOCK）强制 MOCK 时返回 mock:true / lock:true，并给出明确提示。
 *   - 后台「模拟模式」或 ZOVOCARD_MOCK 触发 MOCK 时同样返回 mock:true（lock:false）。
 *   - 真实调用成功时返回 mock:false。
 */
async function testConnection(cfg) {
    if (isMockMode(cfg)) {
        const lock = isMockLockEnabled();
        return {
            success: true,
            mock: true,
            lock,
            message: lock
                ? '当前处于安全锁 MOCK 模式（REQUIRE_ZOVOCARD_MOCK=1），未真实连通 ZovoCard：你填写的 API Key / Base URL 不会被真实使用，也无扣费。'
                : '当前为 MOCK 模式（后台「模拟模式」或 ZOVOCARD_MOCK=1），未真实连通 ZovoCard，无扣费。',
            plans: MOCK_PLANS, gptPlans: MOCK_PLANS, creditPlans: [],
            balance: { spendable_balance: 999.99 }
        };
    }
    const [plansRes, balanceRes] = await Promise.all([
        fetchPlans(cfg),
        queryBalance(cfg)
    ]);

    if (!plansRes.success) {
        return { success: false, mock: false, error: `套餐查询失败: ${plansRes.error}` };
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
        mock: false,
        lock: false,
        message: `已真实连通 ZovoCard API（${messages.join('，')}）`,
        plans: plansRes.plans || [],
        gptPlans: plansRes.gptPlans || [],
        creditPlans: plansRes.creditPlans || [],
        balance: balanceRes.success ? balanceRes.data : null
    };
}

// ─── 卡池/选卡控制面（§6.18.5a） + 卡余额维护（§6.4/6.9/6.8b）──────────────
// 这些能力用于「平台托管卡」的运营与审计：选卡策略、选卡预览、卡剩余次数、
// 卡余额看板与补足、卡资金流水。★ 不影响建单主流程（建单仍走平台自动选卡）★

// 可变 MOCK 策略（PUT 会写回这里，便于后台按钮在 MOCK 下联调）
const MOCK_CARD_RULES = {
    gpt: { product: 'gpt', count_failures: true, light_max_uses: 5, pro20_max_uses: 3, select_mode: 'default', auto_switch_on_fail: true, max_auto_switches: 2, select_priority: [], strict_select: false, is_default: true },
    claude: { product: 'claude', count_failures: true, light_max_uses: 5, pro20_max_uses: 3, select_mode: 'default', auto_switch_on_fail: true, max_auto_switches: 2, select_priority: [], strict_select: false, is_default: true },
    grok: { product: 'grok', count_failures: true, light_max_uses: 5, pro20_max_uses: 3, select_mode: 'default', auto_switch_on_fail: true, max_auto_switches: 2, select_priority: [], strict_select: false, is_default: true }
};

const MOCK_CARDS = [
    { id: 456, card_number: '5311000000001234', available_amount: 12.34, limit: 50, min_recharge: 10, refund_keep_min: 1, issuer: 'one', product_code: 'vm_25', status: 'ACTIVE', card_type: 'vm' },
    { id: 457, card_number: '5311000000005678', available_amount: 3.5, limit: 50, min_recharge: 10, refund_keep_min: 1, issuer: 'one', product_code: 'vm_25', status: 'ACTIVE', card_type: 'vm' },
    { id: 458, card_number: '4200000000009012', available_amount: 0, limit: 20, min_recharge: 0, refund_keep_min: 0, issuer: 'four', product_code: 'sl_20', status: 'FROZEN', card_type: 'vm', balance_as_of: 1792200000, balance_stale: false }
];

const MOCK_CARD_PRODUCTS = [
    { product_code: 'vm_25', label: 'VM 25U', enabled: true, suspended: false, channel_open: true, auto_open_allowed: true, usable: true },
    { product_code: 'sl_20', label: 'StarLink 20U', enabled: true, suspended: false, channel_open: true, auto_open_allowed: true, usable: true }
];

// 可写字段白名单（与文档 §6.18.5a 一一对应；未知字段会被上游 400 拒绝）
const CARD_RULE_FIELDS = ['count_failures', 'light_max_uses', 'pro20_max_uses', 'select_mode', 'auto_switch_on_fail', 'max_auto_switches', 'select_priority', 'strict_select'];

/**
 * 卡对象脱敏：★GET /cards/{id} 会回传完整 PAN / CVV★。
 * 对外（浏览器 / 日志 / 审计表）一律只保留末四位与金额、状态等非敏感字段。
 */
function redactCard(card) {
    if (!card || typeof card !== 'object') return card;
    const raw = String(card.card_number || '').replace(/\D/g, '');
    const last4 = String(card.card_last_four || (raw.length >= 4 ? raw.slice(-4) : '') || '');
    return {
        id: card.id ?? card.card_id ?? null,
        card_last_four: last4 || null,
        available_amount: card.available_amount ?? card.balance ?? null,
        limit: card.limit ?? null,
        min_recharge: card.min_recharge ?? null,
        refund_keep_min: card.refund_keep_min ?? null,
        status: card.status ?? null,
        issuer: card.issuer ?? null,
        product_code: card.product_code ?? null,
        card_type: card.card_type ?? null,
        remark: card.remark ?? null,
        bin_note: card.bin_note ?? null,
        channel_payable: card.channel_payable ?? null,
        balance_as_of: card.balance_as_of ?? null,
        balance_stale: card.balance_stale ?? null,
        delete_pending_at: card.delete_pending_at ?? null,
        created_at: card.created_at ?? null
    };
}

/**
 * 读取选卡策略（GET /gpt-direct/card-rules）。省略 product 返回全部三产品。
 */
async function getCardRules(cfg, { product } = {}) {
    const want = String(product || '').trim().toLowerCase();
    if (isMockMode(cfg)) {
        const list = want
            ? [`${want}`].map((k) => MOCK_CARD_RULES[k]).filter(Boolean).map((r) => ({ ...r }))
            : Object.values(MOCK_CARD_RULES).map((r) => ({ ...r }));
        return { ok: true, success: true, status: 200, httpCode: 200, list, data: { list }, ...mockMeta() };
    }
    const qs = want ? `?product=${encodeURIComponent(want)}` : '';
    const res = await request('GET', `/gpt-direct/card-rules${qs}`, cfg);
    if (!res.success) return res;
    const inner = res.data || {};
    const list = Array.isArray(inner.list) ? inner.list
        : Array.isArray(inner.rules) ? inner.rules
            : Array.isArray(inner) ? inner
                : (inner.product ? [inner] : []);
    return { ok: true, success: true, status: res.status, httpCode: res.httpCode, list, data: inner };
}

/**
 * 更新选卡策略（PUT /gpt-direct/card-rules）。只发白名单字段，避免未知参数被 400 拒绝。
 */
async function putCardRules(cfg, rules = {}) {
    const product = String(rules.product || 'gpt').trim().toLowerCase();
    const body = { product };
    for (const f of CARD_RULE_FIELDS) {
        if (rules[f] !== undefined) body[f] = rules[f];
    }
    if (isMockMode(cfg)) {
        MOCK_CARD_RULES[product] = { ...(MOCK_CARD_RULES[product] || {}), ...body, is_default: false };
        return { ok: true, success: true, status: 200, httpCode: 200, product, applied: { ...MOCK_CARD_RULES[product] }, data: { ...MOCK_CARD_RULES[product] }, ...mockMeta() };
    }
    const res = await request('PUT', '/gpt-direct/card-rules', cfg, { body });
    if (!res.success) return res;
    return { ok: true, success: true, status: res.status, httpCode: res.httpCode, product, applied: res.data, data: res.data };
}

/**
 * 选卡预览（GET /gpt-direct/card-pool/schedule）—— 只预测将选中的卡，不建单、不扣费。
 */
async function previewCardPoolSchedule(cfg, { product = 'gpt', plan, card_mode = 'auto_existing' } = {}) {
    const p = String(product || 'gpt').trim().toLowerCase();
    if (isMockMode(cfg)) {
        const active = MOCK_CARDS.filter((c) => c.status === 'ACTIVE');
        const picked = (active.length ? active : MOCK_CARDS)
            .slice()
            .sort((a, b) => (a.available_amount || 0) - (b.available_amount || 0))[0] || {};
        return {
            ok: true, success: true, status: 200, httpCode: 200,
            data: {
                product: p, plan: plan || 'plus', card_mode,
                selected: {
                    card_id: picked.id ?? null,
                    card_last_four: picked.card_number ? String(picked.card_number).slice(-4) : null,
                    available_amount: picked.available_amount ?? null,
                    reason: 'lowest_usage'
                },
                candidates: MOCK_CARDS.map((c) => ({
                    card_id: c.id, card_last_four: String(c.card_number || '').slice(-4),
                    available_amount: c.available_amount, status: c.status
                })),
                mock: true
            },
            ...mockMeta()
        };
    }
    const params = new URLSearchParams({ product: p, card_mode: String(card_mode) });
    if (plan) params.set('plan', String(plan));
    const res = await request('GET', `/gpt-direct/card-pool/schedule?${params.toString()}`, cfg);
    if (!res.success) return res;
    return { ok: true, success: true, status: res.status, httpCode: res.httpCode, data: res.data };
}

/**
 * 单卡剩余次数（GET /gpt-direct/cards/{id}/usage?product=gpt）。remaining=-1 表示不限次。
 */
async function getCardUsage(cfg, cardId, { product = 'gpt' } = {}) {
    const id = String(cardId ?? '').trim();
    if (!id) return { ok: false, success: false, errorCode: 'INVALID_REQUEST', errorAction: 'terminal', error: '缺少 card_id' };
    const p = String(product || 'gpt').trim().toLowerCase();
    if (isMockMode(cfg)) {
        return { ok: true, success: true, status: 200, httpCode: 200, data: { card_id: Number(id) || id, product: p, remaining: 2, used: 3, light_used: 2, pro20_used: 1, mock: true }, ...mockMeta() };
    }
    const res = await request('GET', `/gpt-direct/cards/${encodeURIComponent(id)}/usage?product=${encodeURIComponent(p)}`, cfg);
    if (!res.success) return res;
    return { ok: true, success: true, status: res.status, httpCode: res.httpCode, data: res.data };
}

/**
 * 卡产品可用性（GET /gpt-direct/card-products）。
 */
async function listCardProducts(cfg) {
    if (isMockMode(cfg)) {
        return { ok: true, success: true, status: 200, httpCode: 200, list: MOCK_CARD_PRODUCTS.map((r) => ({ ...r })), data: { list: MOCK_CARD_PRODUCTS }, ...mockMeta() };
    }
    const res = await request('GET', '/gpt-direct/card-products', cfg);
    if (!res.success) return res;
    const inner = res.data || {};
    const list = Array.isArray(inner.list) ? inner.list : Array.isArray(inner) ? inner : [];
    return { ok: true, success: true, status: res.status, httpCode: res.httpCode, list, data: inner };
}

/**
 * 卡列表（GET /cards）—— 支持 sync=1 触发上游余额同步、balance_sort=asc|desc。
 * 返回的 list 保留原始字段（可能含 PAN），对外请用 redacted。
 */
async function listCards(cfg, { page = 1, page_size = 20, balance_sort, sync, issuer, status, q, archived, exclude_ids } = {}) {
    if (isMockMode(cfg)) {
        let rows = MOCK_CARDS.map((c) => ({ ...c }));
        if (status) rows = rows.filter((c) => String(c.status).toUpperCase() === String(status).toUpperCase());
        if (issuer) rows = rows.filter((c) => c.issuer === String(issuer));
        const bs = String(balance_sort || '');
        if (bs === 'asc') rows.sort((a, b) => (a.available_amount || 0) - (b.available_amount || 0));
        else if (bs === 'desc') rows.sort((a, b) => (b.available_amount || 0) - (a.available_amount || 0));
        return { ok: true, success: true, status: 200, httpCode: 200, total: rows.length, list: rows, redacted: rows.map(redactCard), data: { total: rows.length, list: rows }, ...mockMeta() };
    }
    const params = new URLSearchParams();
    params.set('page', String(Math.max(1, Number(page) || 1)));
    params.set('page_size', String(Math.min(100, Math.max(1, Number(page_size) || 20))));
    const bs = String(balance_sort || '');
    if (bs === 'asc' || bs === 'desc') params.set('balance_sort', bs);
    if (String(sync) === '1' || sync === true) params.set('sync', '1');
    if (issuer) params.set('issuer', String(issuer));
    if (status) params.set('status', String(status));
    if (q) params.set('q', String(q));
    if (archived === '0' || archived === '1' || archived === '') params.set('archived', String(archived));
    if (exclude_ids) params.set('exclude_ids', String(exclude_ids));
    const res = await request('GET', `/cards?${params.toString()}`, cfg);
    if (!res.success) return res;
    const inner = res.data || {};
    const list = Array.isArray(inner.list) ? inner.list : [];
    return { ok: true, success: true, status: res.status, httpCode: res.httpCode, total: Number(inner.total || list.length), list, redacted: list.map(redactCard), data: inner };
}

/**
 * 卡补足（POST /cards/recharge）。
 * ★amount_below_min 是「参数错误、不可重试」★：低于卡的最低充值下限（min_recharge）时返回。
 * 正在确认中的充值不会被重发；上游确认中的补足会回 HTTP 400 而不是 202，同样不要重发。
 */
async function rechargeCard(cfg, { cardId, amount } = {}) {
    const id = Number(cardId);
    const amt = Number(amount);
    if (!Number.isFinite(id) || id <= 0) {
        return { ok: false, success: false, errorCode: 'INVALID_REQUEST', errorAction: 'terminal', error: '缺少 card_id' };
    }
    if (!Number.isFinite(amt) || amt <= 0) {
        return { ok: false, success: false, errorCode: 'INVALID_REQUEST', errorAction: 'terminal', error: '充值金额必须大于 0' };
    }
    if (isMockMode(cfg)) {
        return { ok: true, success: true, status: 200, httpCode: 200, pending: false, msg: '充值成功（MOCK）', data: { mock: true }, ...mockMeta() };
    }
    const res = await request('POST', '/cards/recharge', cfg, { body: { card_id: id, amount: amt } });
    if (!res.success) {
        return { ...res, amountBelowMin: res.errorCode === 'amount_below_min' };
    }
    return { ok: true, success: true, status: res.status, httpCode: res.httpCode, pending: res.accepted === true, msg: res.msg, data: res.data };
}

/**
 * 卡资金流水（GET /cards/{id}/fund-flows）—— 入金 / 充值 / 退款（对卡余额的增减）。
 */
async function listCardFundFlows(cfg, cardId) {
    const id = String(cardId ?? '').trim();
    if (!id) return { ok: false, success: false, errorCode: 'INVALID_REQUEST', errorAction: 'terminal', error: '缺少 card_id' };
    if (isMockMode(cfg)) {
        const rows = [
            { id: 1, type: 'open_card_funding', amount: 25, created_at: '2026-10-01T00:00:00Z' },
            { id: 2, type: 'card_recharge', amount: 10, created_at: '2026-10-10T00:00:00Z' }
        ];
        return { ok: true, success: true, status: 200, httpCode: 200, list: rows, data: rows, ...mockMeta() };
    }
    const res = await request('GET', `/cards/${encodeURIComponent(id)}/fund-flows`, cfg);
    if (!res.success) return res;
    const inner = res.data;
    const list = Array.isArray(inner) ? inner : (Array.isArray(inner?.list) ? inner.list : []);
    return { ok: true, success: true, status: res.status, httpCode: res.httpCode, list, data: inner };
}

module.exports = {
    DEFAULT_BASE_URL,
    isMockMode,
    isMockLockEnabled,
    normalizeBaseUrl,
    maskApiKey,
    normalizeOrderState,
    isTerminalOrderState,
    classifyError,
    sanitizeIdempotencyKey,
    request,
    fetchPlans,
    inspectPay,
    upgradeQuotes,
    submitPay,
    queryOrder,
    queryTask,
    queryBalance,
    listAccountOrders,
    redactCard,
    getCardRules,
    putCardRules,
    previewCardPoolSchedule,
    getCardUsage,
    listCardProducts,
    listCards,
    rechargeCard,
    listCardFundFlows,
    testConnection,
    extractOrderId,
    extractTaskId,
    extractTopupCode,
    extractStatus
};
