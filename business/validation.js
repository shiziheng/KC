'use strict';

const crypto = require('crypto');

const PLAN_CODES = new Set([
    'go', 'plus', 'pro_5x', 'pro_20x', 'pro_50x',
    'credit250', 'credit500', 'credit1000', 'credit2500', 'credit5000', 'credit25000'
]);
const FORBIDDEN_KEYS = new Set([
    'session', 'sessionpayload', 'token', 'accesstoken', 'refreshtoken',
    'cookie', 'cookieheader', 'credential', 'credentialdata', 'password',
    'cardnumber', 'cvc', 'cvv', 'authorization'
]);

class BusinessError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'BusinessError';
        this.status = status;
        this.code = code;
    }
}

function canonicalKey(value) {
    return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function rejectSensitiveFields(value, depth = 0) {
    if (depth > 8 || value == null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(canonicalKey(key))) {
            throw new BusinessError(400, 'SENSITIVE_FIELD_NOT_ALLOWED', '请求包含不允许提交的敏感字段');
        }
        rejectSensitiveFields(nested, depth + 1);
    }
}

function assertPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BusinessError(400, 'INVALID_BODY', '请求数据格式不正确');
    }
    rejectSensitiveFields(value);
}

function decimalPlaces(currency) {
    return String(currency || '').toUpperCase() === 'USDT' ? 6 : 2;
}

function parseMoney(value, currency = 'USD', { minMinor = 1, maxMinor = 9_000_000_000_000 } = {}) {
    const places = decimalPlaces(currency);
    const raw = String(value ?? '').trim();
    const match = raw.match(/^(0|[1-9]\d{0,8})(?:\.(\d{1,6}))?$/);
    if (!match || ((match[2] || '').length > places)) {
        throw new BusinessError(400, 'INVALID_AMOUNT', `金额格式不正确，${currency} 最多支持 ${places} 位小数`);
    }
    const fraction = (match[2] || '').padEnd(places, '0');
    const scale = 10 ** places;
    const minor = Number(match[1]) * scale + Number(fraction || 0);
    if (!Number.isSafeInteger(minor) || minor < minMinor || minor > maxMinor) {
        throw new BusinessError(400, 'AMOUNT_OUT_OF_RANGE', '金额超出允许范围');
    }
    return minor;
}

function formatMoney(minor, currency = 'USD') {
    const places = decimalPlaces(currency);
    const value = Number(minor);
    if (!Number.isSafeInteger(value)) return '0.' + '0'.repeat(places);
    const scale = 10 ** places;
    return `${Math.floor(value / scale)}.${String(value % scale).padStart(places, '0')}`;
}

function normalizeProduct(input, { allowedPlanCodes = PLAN_CODES } = {}) {
    assertPlainObject(input);
    const productCode = String(input.productCode || '').trim().toLowerCase();
    const name = String(input.name || '').trim();
    const planCode = String(input.planCode || '').trim().toLowerCase();
    const currency = String(input.currency || 'USD').trim().toUpperCase();
    const availability = String(input.availability || 'onsale').trim().toLowerCase();

    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(productCode)) {
        throw new BusinessError(400, 'INVALID_PRODUCT_CODE', '商品编号需为 2-64 位英文、数字、连字符或下划线');
    }
    if (!name || name.length > 160) {
        throw new BusinessError(400, 'INVALID_PRODUCT_NAME', '商品名称不能为空且不能超过 160 个字符');
    }
    const acceptedPlanCodes = allowedPlanCodes instanceof Set ? allowedPlanCodes : PLAN_CODES;
    if (!acceptedPlanCodes.has(planCode)) {
        throw new BusinessError(400, 'INVALID_PLAN_CODE', '请选择有效的代充套餐');
    }
    if (!['USD', 'USDT'].includes(currency)) {
        throw new BusinessError(400, 'INVALID_CURRENCY', '当前只支持 USD 商品价和 USDT 充值');
    }
    if (!['onsale', 'off_sale'].includes(availability)) {
        throw new BusinessError(400, 'INVALID_AVAILABILITY', '商品状态无效');
    }

    const faceAmountMinor = parseMoney(input.faceAmount, currency);
    const sellingAmountMinor = parseMoney(input.sellingAmount, currency);
    const costAmountMinor = input.costAmount === '' || input.costAmount == null
        ? null
        : parseMoney(input.costAmount, currency, { minMinor: 0 });

    return {
        productCode,
        name,
        planCode,
        currency,
        faceAmountMinor,
        sellingAmountMinor,
        costAmountMinor,
        availability
    };
}

function normalizeEmail(raw) {
    const email = String(raw || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BusinessError(400, 'INVALID_ACCOUNT', '请填写有效的账号邮箱');
    }
    return email;
}

function maskEmail(email) {
    const [local, domain] = String(email || '').split('@');
    if (!local || !domain) return '';
    const visible = local.length < 3 ? local.slice(0, 1) : local.slice(0, 2);
    return `${visible}${'*'.repeat(Math.max(3, Math.min(8, local.length - visible.length)))}@${domain}`;
}

function accountFingerprint(email) {
    const secret = process.env.BUSINESS_ACCOUNT_HASH_SECRET
        || process.env.ADMIN_TOKEN_SECRET
        || process.env.DB_PASSWORD
        || process.cwd();
    return crypto.createHmac('sha256', String(secret)).update(String(email)).digest('hex');
}

function normalizeReason(value) {
    const reason = String(value || '').trim();
    if (reason.length < 6 || reason.length > 300) {
        throw new BusinessError(400, 'REASON_REQUIRED', '请填写至少 6 个字符的操作原因');
    }
    if (/(session|access[_ -]?token|refresh[_ -]?token|cookie|password|密码|卡号|cvc|cvv|sk_[a-z0-9]{8,})/i.test(reason)) {
        throw new BusinessError(400, 'SENSITIVE_TEXT_NOT_ALLOWED', '操作说明不能包含账号授权信息、密码或支付凭据');
    }
    return reason;
}

function makeRef(prefix, bytes = 12) {
    return `${prefix}-${crypto.randomBytes(bytes).toString('hex').toUpperCase()}`;
}

function makeMockTransactionRef() {
    return `MOCK-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function normalizeIdempotencyKey(value) {
    const key = String(value || '').trim();
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) {
        throw new BusinessError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请重试操作，缺少有效的幂等请求编号');
    }
    return key;
}

module.exports = {
    BusinessError,
    PLAN_CODES,
    assertPlainObject,
    parseMoney,
    formatMoney,
    normalizeProduct,
    normalizeEmail,
    maskEmail,
    accountFingerprint,
    normalizeReason,
    makeRef,
    makeMockTransactionRef,
    normalizeIdempotencyKey
};
