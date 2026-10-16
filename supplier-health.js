'use strict';

/**
 * S8 供应商健康摘要（KC 侧）
 *
 * 履约链路的前置门槛：商城（KC 前台）在「商品展示」与「下单前置检查」
 * 两处读取本摘要 —— 只有 status=healthy 且 sellable=true 且对应套餐
 * available=true 时才允许售卖；任何异常都 fail-closed（不可售）。
 *
 * 状态机：
 *   unknown  初始（未完成首次检查）
 *   healthy  上游正常且余额充足 → 可售
 *   degraded 上游失败 1 次 → 暂不可售（等待下次自动恢复）
 *   soldout  连续失败 2 次 / 余额过低 → 熔断，必须人工恢复（restore）
 *   soldout + 上游恢复 → 保持熔断并置 recovery_ready，等待人工确认后恢复
 *
 * 字段命名与 2026-10-07 版持久化数据保持兼容：
 *   failure_count / last_probe_status / last_probe_reason_code / manual_override …
 *
 * 底层上游读取复用 zovocard-client（Mock 模式下为本地模拟，不产生任何真实调用）。
 */

const STATUS = {
    UNKNOWN: 'unknown',
    HEALTHY: 'healthy',
    DEGRADED: 'degraded',
    SOLDOUT: 'soldout'
};

const REASONS = {
    INITIAL: 'initial',
    OK: 'ok',
    UPSTREAM_FAILED: 'upstream_failed',
    LOW_BALANCE: 'low_balance',
    NO_PLAN: 'no_plan',
    MANUAL_RESTORE_REQUIRED: 'manual_restore_required',
    MANUAL_RESTORED: 'manual_restored'
};

/** 可用余额安全线（跑量前保留的最低额度；低于即熔断待人工恢复） */
const MIN_BALANCE = 10;

function baseState(now) {
    return {
        status: STATUS.UNKNOWN,
        sellable: false,
        reason_code: REASONS.INITIAL,
        reason: '尚未完成供应商健康检查',
        checked_at: null,
        last_success_at: null,
        balance: null,
        plans: [],
        failure_count: 0,
        manual_override: false,
        recovery_ready: false,
        last_probe_status: null,
        last_probe_reason_code: null,
        mock: false,
        updated_at: now || null
    };
}

function extractBalance(balanceResult) {
    if (!balanceResult || balanceResult.success !== true) return null;
    const data = balanceResult.data || {};
    const raw = (data.spendable_balance != null)
        ? data.spendable_balance
        : (data.balance != null ? data.balance : (balanceResult.balance != null ? balanceResult.balance : null));
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

function normalizePlans(plansResult) {
    const list = [];
    if (plansResult && plansResult.success === true && Array.isArray(plansResult.plans)) {
        for (const plan of plansResult.plans) {
            const key = String((plan && plan.key) || '').trim();
            if (!key) continue;
            list.push({
                key,
                name: String((plan && plan.name) || key),
                available: plan.enabled === true && plan.purchasable === true
            });
        }
    }
    return list;
}

/**
 * 评估供应商健康状态。
 *
 * @param {object}  opts
 * @param {object} [opts.previous]      上一次的持久化状态（baseState() 起步）
 * @param {object} [opts.plansResult]   zovocard-client fetchPlans() 结果
 * @param {object} [opts.balanceResult] zovocard-client queryBalance() 结果
 * @param {string} [opts.now]           ISO 时间戳
 * @param {boolean}[opts.mock]          本次评估是否来自 Mock 数据
 * @returns {object} 新状态（由调用方持久化）
 */
function evaluateSupplierHealth({ previous, plansResult, balanceResult, now, mock } = {}) {
    const prev = (previous && typeof previous === 'object') ? previous : baseState();
    const at = now || new Date().toISOString();
    const isMock = mock === true || prev.mock === true;

    const upstreamOk = Boolean(
        plansResult && plansResult.success === true &&
        balanceResult && balanceResult.success === true
    );
    const balance = extractBalance(balanceResult);
    const plans = normalizePlans(plansResult);
    const keepPlans = plans.length > 0 ? plans : (Array.isArray(prev.plans) ? prev.plans : []);

    if (!upstreamOk) {
        const failures = (Number(prev.failure_count) || 0) + 1;
        const soldout = failures >= 2 || prev.status === STATUS.SOLDOUT;
        return {
            ...prev,
            status: soldout ? STATUS.SOLDOUT : STATUS.DEGRADED,
            sellable: false,
            reason_code: REASONS.UPSTREAM_FAILED,
            reason: soldout
                ? '供应商接口连续异常，已暂停售卖，等待人工处理'
                : '供应商接口异常，暂不可售（等待下次检查自动恢复）',
            checked_at: at,
            balance: balance != null ? balance : prev.balance,
            plans: keepPlans,
            failure_count: failures,
            recovery_ready: false,
            last_probe_status: 'failed',
            last_probe_reason_code: REASONS.UPSTREAM_FAILED,
            mock: isMock,
            updated_at: at
        };
    }

    // 上游已恢复，但此前处于熔断：保持熔断，等待人工恢复（fail-closed）
    if (prev.status === STATUS.SOLDOUT) {
        return {
            ...prev,
            status: STATUS.SOLDOUT,
            sellable: false,
            reason_code: REASONS.MANUAL_RESTORE_REQUIRED,
            reason: '供应商已恢复，需人工确认后恢复售卖',
            checked_at: at,
            last_success_at: at,
            balance,
            plans: keepPlans,
            failure_count: 0,
            recovery_ready: true,
            last_probe_status: 'healthy',
            last_probe_reason_code: REASONS.OK,
            mock: isMock,
            updated_at: at
        };
    }

    if (balance == null || balance < MIN_BALANCE) {
        return {
            ...prev,
            status: STATUS.SOLDOUT,
            sellable: false,
            reason_code: REASONS.LOW_BALANCE,
            reason: '供应商可用余额过低，已暂停售卖，等待人工处理',
            checked_at: at,
            balance,
            plans: keepPlans,
            failure_count: 0,
            recovery_ready: false,
            last_probe_status: 'healthy',
            last_probe_reason_code: REASONS.OK,
            mock: isMock,
            updated_at: at
        };
    }

    if (!keepPlans.some((plan) => plan.available === true)) {
        return {
            ...prev,
            status: STATUS.SOLDOUT,
            sellable: false,
            reason_code: REASONS.NO_PLAN,
            reason: '供应商暂无可售套餐，已暂停售卖',
            checked_at: at,
            last_success_at: at,
            balance,
            plans: keepPlans,
            failure_count: 0,
            recovery_ready: false,
            last_probe_status: 'healthy',
            last_probe_reason_code: REASONS.OK,
            mock: isMock,
            updated_at: at
        };
    }

    return {
        ...prev,
        status: STATUS.HEALTHY,
        sellable: true,
        reason_code: REASONS.OK,
        reason: '供应商正常',
        checked_at: at,
        last_success_at: at,
        balance,
        plans: keepPlans,
        failure_count: 0,
        recovery_ready: false,
        last_probe_status: 'healthy',
        last_probe_reason_code: REASONS.OK,
        mock: isMock,
        updated_at: at
    };
}

/** 某个具体档位（plus / pro_5x / pro_20x…）当前是否可售 */
function isPlanSellable(state, planKey) {
    if (!state || state.status !== STATUS.HEALTHY || state.sellable !== true) return false;
    const plans = Array.isArray(state.plans) ? state.plans : [];
    return plans.some((plan) => String(plan.key) === String(planKey) && plan.available === true);
}

/**
 * 人工恢复：熔断后经人工确认，恢复为可售。
 * @returns {{ok: boolean, state: object}}
 */
function restoreSupplierHealth(state, now) {
    const at = now || new Date().toISOString();
    const prev = (state && typeof state === 'object') ? state : baseState();
    return {
        ok: true,
        state: {
            ...prev,
            status: STATUS.HEALTHY,
            sellable: true,
            reason_code: REASONS.MANUAL_RESTORED,
            reason: '',
            checked_at: at,
            last_success_at: at,
            failure_count: 0,
            recovery_ready: false,
            last_probe_status: 'healthy',
            last_probe_reason_code: REASONS.OK,
            updated_at: at
        }
    };
}

/** 对外（商城插件）读取的公开字段，内部字段不外发 */
function toPublic(state) {
    const s = (state && typeof state === 'object') ? state : baseState();
    return {
        status: s.status || STATUS.UNKNOWN,
        sellable: s.sellable === true,
        reason_code: s.reason_code || REASONS.INITIAL,
        reason: s.reason || '',
        checked_at: s.checked_at || null,
        last_success_at: s.last_success_at || null,
        balance: (typeof s.balance === 'number' && Number.isFinite(s.balance)) ? s.balance : null,
        plans: Array.isArray(s.plans) ? s.plans.map((p) => ({
            key: String(p.key || ''),
            name: String(p.name || p.key || ''),
            available: p.available === true
        })) : [],
        recovery_ready: s.recovery_ready === true,
        manual_override: s.manual_override === true,
        mock: s.mock === true
    };
}

module.exports = {
    STATUS,
    REASONS,
    MIN_BALANCE,
    baseState,
    evaluateSupplierHealth,
    isPlanSellable,
    restoreSupplierHealth,
    toPublic
};
