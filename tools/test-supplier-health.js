'use strict';

/**
 * S8 供应商健康摘要 · 状态机自测（随 v1.11.3 固化）
 *
 * 运行：node tools/test-supplier-health.js
 * 覆盖：healthy → degraded（1 次失败）→ soldout（连续 2 次）→ 上游恢复（需人工）→ 人工恢复 → 余额过低
 */

const assert = require('node:assert/strict');
const health = require('../supplier-health');

const plans = {
    success: true,
    plans: [
        { key: 'plus', name: 'ChatGPT Plus', enabled: true, purchasable: true },
        { key: 'pro_5x', name: 'ChatGPT Pro (5x)', enabled: true, purchasable: true },
        { key: 'pro_20x', name: 'ChatGPT Pro (20x)', enabled: true, purchasable: true }
    ]
};
const balance = { success: true, balance: 999.99, data: { spendable_balance: 999.99 } };
const failed = { success: false, error: 'synthetic upstream 5xx' };

let state = health.evaluateSupplierHealth({
    previous: health.baseState(), plansResult: plans, balanceResult: balance,
    now: '2026-10-06T00:00:00.000Z'
});
assert.equal(state.status, health.STATUS.HEALTHY);
assert.equal(state.sellable, true);
assert.equal(health.isPlanSellable(state, 'plus'), true);

state = health.evaluateSupplierHealth({ previous: state, plansResult: failed, balanceResult: failed,
    now: '2026-10-06T00:01:00.000Z' });
assert.equal(state.status, health.STATUS.DEGRADED);
assert.equal(state.sellable, false);

state = health.evaluateSupplierHealth({ previous: state, plansResult: failed, balanceResult: failed,
    now: '2026-10-06T00:02:00.000Z' });
assert.equal(state.status, health.STATUS.SOLDOUT);
assert.equal(state.sellable, false);

state = health.evaluateSupplierHealth({ previous: state, plansResult: plans, balanceResult: balance,
    now: '2026-10-06T00:03:00.000Z' });
assert.equal(state.status, health.STATUS.SOLDOUT);
assert.equal(state.recovery_ready, true);
assert.equal(state.reason_code, health.REASONS.MANUAL_RESTORE_REQUIRED);

const restored = health.restoreSupplierHealth(state, '2026-10-06T00:04:00.000Z');
assert.equal(restored.ok, true);
assert.equal(restored.state.status, health.STATUS.HEALTHY);
assert.equal(restored.state.sellable, true);

const lowBalance = health.evaluateSupplierHealth({
    previous: health.baseState(), plansResult: plans,
    balanceResult: { success: true, balance: 3, data: { spendable_balance: 3 } },
    now: '2026-10-06T00:05:00.000Z'
});
assert.equal(lowBalance.status, health.STATUS.SOLDOUT);
assert.equal(lowBalance.reason_code, health.REASONS.LOW_BALANCE);

console.log(JSON.stringify({
    ok: true,
    healthy: 'healthy',
    degraded: 'degraded',
    soldout: 'soldout',
    restored: restored.state.status,
    low_balance: lowBalance.reason_code
}));
