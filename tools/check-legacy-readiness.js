#!/usr/bin/env node
// tools/check-legacy-readiness.js
// v1.21.0 · R7 老字段下掉评估（SP §R7）
// 离线一致性检查：xboard.v2_plan vs plus_papay.kc_*
// 输出 ready_to_drop_legacy 决策依据
const fs = require('fs');
const path = require('path');

(async function main() {
    const env = {};
    for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
        const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    const mysql = require(path.join(__dirname, '..', 'node_modules', 'mysql2', 'promise'));
    const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3310, user: 'root', password: env.DB_PASSWORD || 'root', database: 'plus_papay', ssl: false });

    const V2_KC_PERIOD_MAP = { monthly: 'month', onetime: 'once', quarterly: 'quarter', yearly: 'year' };

    const [legacyRows] = await conn.query('SELECT id, name, prices, kc_card, kc_is_topup, kc_topup_amount FROM xboard.v2_plan ORDER BY id');
    const [kcRows] = await conn.query('SELECT id, code, kc_type, display_name FROM kc_plans ORDER BY id');
    const [ruleRows] = await conn.query("SELECT plan_id, period, amount_cents FROM kc_pricing_rules WHERE source='manual' AND enabled=1");
    const [cardRows] = await conn.query('SELECT plan_id, listing_state, is_visible FROM kc_listing_cards');

    const ruleMap = {}; for (const r of ruleRows) { (ruleMap[r.plan_id] = ruleMap[r.plan_id] || {})[r.period] = Number(r.amount_cents); }
    const cardMap = {}; for (const r of cardRows) { cardMap[r.plan_id] = r; }

    const report = {
        ts: new Date().toISOString(),
        legacy_v2_plan_count: legacyRows.length,
        kc_plans_count: kcRows.length,
        summary: { matches: 0, mismatches: 0, kc_only: 0, legacy_only: 0 },
        plans: []
    };
    for (const v of legacyRows) {
        const code = 'xplan_' + v.id;
        const kc = kcRows.find(k => k.code === code);
        const item = { v2_plan_id: v.id, name: v.name, code, kc_plan_id: kc && kc.id, mismatches: [] };
        if (!kc) {
            item.mismatches.push('KC 侧无对应 plan');
            report.summary.legacy_only++;
        } else {
            let vPrices = {};
            try { vPrices = typeof v.prices === 'string' ? JSON.parse(v.prices) : (v.prices || {}); } catch (e) { vPrices = {}; }
            const kcPrices = ruleMap[kc.id] || {};
            for (const [vKey, vVal] of Object.entries(vPrices)) {
                const kKey = V2_KC_PERIOD_MAP[vKey] || vKey;
                const kVal = kcPrices[kKey];
                if (kVal == null) { item.mismatches.push('KC 侧缺价 period=' + kKey); continue; }
                const vCents = Math.round(Number(vVal) * 100);
                if (vCents !== kVal) item.mismatches.push('价不一致：v2_plan.' + vKey + '=' + vCents + 'c ≠ kc.' + kKey + '=' + kVal + 'c');
            }
            if (Number(v.kc_is_topup) === 1 && kc.kc_type !== 'recharge') item.mismatches.push('kc_type≠recharge');
            let vCard = null;
            try { vCard = typeof v.kc_card === 'string' ? JSON.parse(v.kc_card) : (v.kc_card || null); } catch (e) {}
            const kcCard = cardMap[kc.id];
            if (!kcCard && vCard && Object.keys(vCard).length) item.mismatches.push('kc_listing_cards 缺失');
            else if (kcCard && Number(v.kc_is_topup) === 0 && kcCard.is_visible === 0) item.mismatches.push('is_visible=0 但 v2_plan.kc_is_topup=0');
            if (item.mismatches.length) report.summary.mismatches++; else report.summary.matches++;
        }
        report.plans.push(item);
    }
    for (const k of kcRows) {
        const id = Number(String(k.code).replace('xplan_', ''));
        if (!legacyRows.find(v => v.id === id)) { report.summary.kc_only++; report.plans.push({ code: k.code, kc_plan_id: k.id, mismatches: ['v2_plan 缺失（KC 侧孤儿 plan）'] }); }
    }
    report.ready_to_drop_legacy = (report.summary.mismatches === 0 && report.summary.legacy_only === 0 && report.summary.kc_only === 0);

    fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'logs', 'legacy-readiness.json'), JSON.stringify(report, null, 2));

    // 控制台输出
    console.log('\n=== 老字段下掉就绪度评估 ===');
    console.log('legacy v2_plan count:', report.legacy_v2_plan_count);
    console.log('kc_plans count:', report.kc_plans_count);
    console.log('summary:', report.summary);
    console.log('ready_to_drop_legacy:', report.ready_to_drop_legacy);
    if (report.summary.mismatches || report.summary.legacy_only || report.summary.kc_only) {
        console.log('\n--- 不一致的 plan ---');
        report.plans.filter(p => p.mismatches && p.mismatches.length).slice(0, 20).forEach(p => {
            console.log('plan', p.v2_plan_id || '(kc_only)', p.name || p.code, ':', p.mismatches.join('; '));
        });
    }
    await conn.end();
    process.exit(report.ready_to_drop_legacy ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(2); });
