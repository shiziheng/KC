'use strict';

/**
 * 实时汇率服务（v2.20.0）—— 把「某币种金额」折算为 USD。
 *
 * 背景：ZovoCard 的「升级差额 / 实付金额」由**账户发票币种**决定（常见 PHP/JPY…），
 *       不是 USD。平台钱包是 USD 账本，故必须先按实时汇率折算再计价/结算。
 *
 * 约定：
 *  - 汇率口径统一为「1 单位该币种 = ? USD」（usd_per_currency）；USD 恒为 1（无需外呼）。
 *  - ★两级新鲜度（v2.20.x）★：
 *      · fresh     = 缓存未超 TTL（默认 10 分钟）→ 直接用（不再外呼）；
 *      · stale     = 外呼失败、但缓存未超「最大容忍时长」（默认 24 小时）→ 用最近缓存值，
 *                    并给出 `buffer_percent`（默认 3）作为**安全垫**，由调用方用于「预估冻结额」；
 *      · too_stale = 外呼失败且缓存超过最大容忍时长，或**根本没有缓存** → ok=false（★绝不臆测汇率★）。
 *    为什么 stale 要加安全垫：升级结算是「多退、少补不追」—— 若回退的汇率偏低会**少收且不可追补**，
 *    故预估阶段宁可略高，开通完成后按上游实付金额把多收的部分退回（多退）。
 *    ★安全垫只用于「预估冻结」，**不得**用于「实付结算」★（结算要的是准确价）。
 *  - MOCK 模式（REQUIRE_ZOVOCARD_MOCK 安全锁 或 FX_RATE_MOCK=1）→ 用本地夹具汇率表，
 *    绝不外呼，保证测试确定性。
 */

const axios = require('axios');

const DEFAULT_FX_API = 'https://open.er-api.com/v6/latest';
const CACHE_TTL_MS = Math.max(60 * 1000, Number(process.env.FX_RATE_CACHE_TTL_MS || 10 * 60 * 1000));
const MAX_STALE_MS = Math.max(CACHE_TTL_MS, Number(process.env.FX_RATE_MAX_STALE_MS || 24 * 60 * 60 * 1000));
const STALE_BUFFER_PERCENT = Math.max(0, Number(process.env.FX_RATE_STALE_BUFFER_PERCENT || 3));
const TIMEOUT_MS = Math.max(1000, Number(process.env.FX_RATE_TIMEOUT_MS || 5000));

function resolveApiBase() {
    const raw = String(process.env.FX_RATE_API || DEFAULT_FX_API).trim().replace(/\/+$/, '');
    return raw || DEFAULT_FX_API;
}

// MOCK 夹具汇率（1 单位该币种 = ? USD）。仅为测试确定性；真实环境走实时 API。
const MOCK_USD_PER = Object.freeze({
    USD: 1,
    PHP: 0.02,
    JPY: 0.0067,
    EUR: 1.08,
    GBP: 1.27,
    CNY: 0.14,
    HKD: 0.128,
    TWD: 0.031,
    THB: 0.028,
    MYR: 0.22,
    SGD: 0.74,
    KRW: 0.00072,
    INR: 0.012,
    IDR: 0.000063,
    VND: 0.00004
});

function isMock() {
    const lock = String(process.env.REQUIRE_ZOVOCARD_MOCK ?? '1').trim().toLowerCase();
    const lockOn = !['0', 'false', 'no', 'off'].includes(lock);
    const envOn = ['1', 'true', 'yes', 'on'].includes(String(process.env.FX_RATE_MOCK || '').trim().toLowerCase());
    return lockOn || envOn;
}

// 进程内缓存：currency → { usdPerCur, ts, source }
const cache = new Map();

async function fetchUsdPerCurrency(cur) {
    const url = `${resolveApiBase()}/${encodeURIComponent(cur)}`;
    const res = await axios.get(url, { timeout: TIMEOUT_MS, proxy: false, validateStatus: () => true });
    const data = res && res.data;
    if (!res || res.status !== 200 || !data || typeof data !== 'object') throw new Error('fx_http_invalid');
    if (data.result && String(data.result) !== 'success') throw new Error('fx_api_' + String(data.result));
    const usd = data.rates && data.rates.USD;
    const n = Number(usd);
    if (!Number.isFinite(n) || n <= 0) throw new Error('fx_rate_invalid');
    return n;
}

/**
 * 判定缓存汇率的新鲜度（纯函数，便于单测）：
 *   age ≤ ttl              → 'fresh'（可直接用）
 *   ttl < age ≤ maxStale   → 'stale'（可回退，但需安全垫）
 *   age > maxStale         → 'too_stale'（禁止使用）
 */
function classifyRateAge(ageMs, opts = {}) {
    const age = Number(ageMs);
    if (!Number.isFinite(age) || age < 0) return 'fresh';
    const ttl = Number.isFinite(Number(opts.ttlMs)) ? Number(opts.ttlMs) : CACHE_TTL_MS;
    const maxStale = Number.isFinite(Number(opts.maxStaleMs)) ? Number(opts.maxStaleMs) : MAX_STALE_MS;
    if (age <= ttl) return 'fresh';
    if (age <= maxStale) return 'stale';
    return 'too_stale';
}

/**
 * 取「1 单位 currency = ? USD」。
 * @returns {{ok:boolean, usd_per_currency?:number, currency:string, source:string, stale?:boolean,
 *            cache_age_ms?:number, buffer_percent?:number, error?:string}}
 */
async function getUsdPerCurrency(currency) {
    const cur = String(currency || 'USD').trim().toUpperCase() || 'USD';
    if (cur === 'USD') return { ok: true, usd_per_currency: 1, currency: 'USD', source: 'fixed', stale: false, buffer_percent: 0 };

    if (isMock()) {
        const n = MOCK_USD_PER[cur];
        if (!Number.isFinite(n) || n <= 0) return { ok: false, currency: cur, source: 'mock', error: 'fx_mock_unsupported' };
        return { ok: true, usd_per_currency: n, currency: cur, source: 'mock', stale: false, buffer_percent: 0 };
    }

    const cached = cache.get(cur);
    if (cached) {
        const age = Date.now() - cached.ts;
        if (classifyRateAge(age) === 'fresh') {
            return { ok: true, usd_per_currency: cached.usdPerCur, currency: cur, source: cached.source, stale: false, cache_age_ms: age, buffer_percent: 0 };
        }
    }
    try {
        const n = await fetchUsdPerCurrency(cur);
        cache.set(cur, { usdPerCur: n, ts: Date.now(), source: 'live' });
        return { ok: true, usd_per_currency: n, currency: cur, source: 'live', stale: false, cache_age_ms: 0, buffer_percent: 0 };
    } catch (e) {
        if (cached) {
            const age = Date.now() - cached.ts;
            const cls = classifyRateAge(age);
            if (cls === 'stale') {
                // 回退最近缓存 + 安全垫（仅供「预估冻结额」；实付结算须传 buffer_percent=0）
                return {
                    ok: true, usd_per_currency: cached.usdPerCur, currency: cur, source: 'stale_cache',
                    stale: true, cache_age_ms: age, buffer_percent: STALE_BUFFER_PERCENT,
                    error: String((e && e.message) || e)
                };
            }
            // too_stale：缓存太旧，禁止使用（绝不臆测）
            return { ok: false, currency: cur, source: 'unavailable', error: 'fx_cache_too_stale', cache_age_ms: age };
        }
        return { ok: false, currency: cur, source: 'unavailable', error: String((e && e.message) || e) };
    }
}

/**
 * 升级零售价：costUSD = (amountMinor / 10^exponent) × usd_per_currency；
 *             retail = round(costUSD × 100 × (1 + buffer%) × (1 + markup%))。
 * ★exponent 会变（JPY=0）—— 绝不一律 ÷100★
 * buffer_percent：仅在「汇率回退到最近缓存」时由 getUsdPerCurrency 给出；实付结算必须传 0。
 */
function computeUpgradeRetailCents({ amountMinor, exponent, usdPerCurrency, markupPercent, bufferPercent }) {
    const expRaw = Number(exponent);
    const exp = Number.isFinite(expRaw) ? expRaw : 2;
    const minor = Number(amountMinor);
    if (!Number.isFinite(minor) || minor < 0) return { ok: false, error: 'amount_invalid' };
    const rate = Number(usdPerCurrency);
    if (!Number.isFinite(rate) || rate <= 0) return { ok: false, error: 'fx_invalid' };
    const mk = Math.max(0, Number(markupPercent) || 0);
    const buf = Math.max(0, Number(bufferPercent) || 0);
    const major = minor / Math.pow(10, exp);
    const costCents = Math.round(major * rate * 100);                       // 真实成本（不含安全垫）
    const basisCents = major * rate * (1 + buf / 100) * 100;                // 预估基准（含安全垫，未取整）
    const estCents = Math.round(basisCents);                                // 预估成本
    const retailCents = Math.round(basisCents * (1 + mk / 100));            // 预估零售（冻结额）
    return {
        ok: true,
        cost_cents: costCents,
        est_cents: estCents,
        retail_cents: retailCents,
        markup_percent: mk,
        buffer_percent: buf,
        usd_per_currency: rate,
        exponent: exp
    };
}

module.exports = { getUsdPerCurrency, computeUpgradeRetailCents, classifyRateAge, isMock, MOCK_USD_PER, CACHE_TTL_MS, MAX_STALE_MS, STALE_BUFFER_PERCENT };
