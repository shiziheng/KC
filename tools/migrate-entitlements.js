#!/usr/bin/env node
// tools/migrate-entitlements.js
// v1.18.0 · 权益 MVP 回填（SP-2026-10-11-v1.0.1 §R4）
// 幂等 INSERT IGNORE：可重跑，不破坏现有规则/grants/uses
// 默认回填 2 条规则（演示价格型权益）：plus_member_off20（会员 8 折）+ pro_newuser_fixed50（新客立减 0.5 USD）
const fs = require('fs');
const path = require('path');

(async function main() {
    const env = {};
    for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    const mysql = require(path.join(__dirname, '..', 'node_modules', 'mysql2', 'promise'));
    const conn = await mysql.createConnection({
        host: '127.0.0.1', port: 3310,
        user: env.MYSQL_USER || 'root',
        password: env.MYSQL_ROOT_PASSWORD || env.MYSQL_PASSWORD || env.DB_PASSWORD || '',
        database: 'plus_papay', ssl: false
    });

    const seedRules = [
        {
            code: 'plus_member_off20',
            display_name: 'Plus 会员 8 折',
            plan_scope: JSON.stringify(['xplan_1']), // 仅 xplan_1（plus 默认 SKU）
            discount_type: 'percent', discount_value: 20,
            min_order_cents: 0, grant_uses: 1, grant_period_days: 30,
            priority: 100, status: 'active', source: 'manual',
            trigger_plan_code: null, valid_from: null, valid_until: null,
            note: 'MVP 演示规则：会员本人下 plus 单享 8 折；R5 自动触发'
        },
        {
            code: 'pro_newuser_fixed50',
            display_name: 'Pro 新客立减 $0.5',
            plan_scope: JSON.stringify([]), // 空数组=全部 plan 适用
            discount_type: 'fixed_cents', discount_value: 50, // 0.5 USD = 50 cents
            min_order_cents: 100, // 至少 $1 才减
            grant_uses: 1, grant_period_days: 7,
            priority: 90, status: 'active', source: 'manual',
            trigger_plan_code: null, valid_from: null, valid_until: null,
            note: 'MVP 演示规则：新客 7 天内下任何 ≥$1 的单立减 $0.5'
        },
        {
            // v1.19.0 · R5 演示：购买 plus 后自动发一次 8 折权益（30 天有效，仅 1 次）
            code: 'plus_purchase_off20_grant',
            display_name: 'Plus 复购券（购买自动发）',
            plan_scope: JSON.stringify(['xplan_1']),
            discount_type: 'percent', discount_value: 20,
            min_order_cents: 0, grant_uses: 1, grant_period_days: 30,
            priority: 100, status: 'active', source: 'purchase',
            trigger_plan_code: 'xplan_1', valid_from: null, valid_until: null,
            note: 'R5 演示：购买 plus 时插件回调 KC 自动下发，复购 plus 可享 8 折'
        },
        {
            // v1.20.0 · R6 演示：plus 购买事件触发 audit_log 动作（事件型权益 demo）
            code: 'plus_purchase_event_audit',
            display_name: 'Plus 购买事件·审计日志',
            plan_scope: JSON.stringify([]),
            discount_type: 'percent', discount_value: 0, // 无折扣，仅作事件触发器
            min_order_cents: 0, grant_uses: 0, grant_period_days: 0, // 不下发 grant
            priority: 80, status: 'active', source: 'event',
            trigger_plan_code: 'plan_purchased', valid_from: null, valid_until: null,
            note: 'R6 演示 handler=audit_log：每次 plan_purchased 事件写一条动作流水；trigger 字段支持 note 内 key:value 配置（handler=audit_log）'
        },
        {
            // v1.20.0 · R6 演示：plus 购买事件触发"升级意向"记录（plan_switch demo handler）
            code: 'plus_purchase_upgrade_intent',
            display_name: 'Plus 购买事件·升级意向',
            plan_scope: JSON.stringify([]),
            discount_type: 'percent', discount_value: 0,
            min_order_cents: 0, grant_uses: 0, grant_period_days: 0,
            priority: 70, status: 'active', source: 'event',
            trigger_plan_code: 'plan_purchased', valid_from: null, valid_until: null,
            note: 'R6 演示 handler=plan_switch target=xplan_3：plus 购买时记录升级到 pro 的意向（v1.20.0 仅记录不实切换）'
        }
    ];

    let inserted = 0, reused = 0;
    for (const r of seedRules) {
        // 1) 先查在不在
        const [exist] = await conn.query('SELECT id FROM kc_entitlement_rules WHERE code=?', [r.code]);
        if (exist.length) {
            reused++;
            continue;
        }
        await conn.query(
            'INSERT INTO kc_entitlement_rules (code, display_name, plan_scope, discount_type, discount_value, min_order_cents, grant_uses, grant_period_days, priority, status, source, trigger_plan_code, valid_from, valid_until, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [r.code, r.display_name, r.plan_scope, r.discount_type, r.discount_value, r.min_order_cents, r.grant_uses, r.grant_period_days, r.priority, r.status, r.source, r.trigger_plan_code, r.valid_from, r.valid_until, r.note]
        );
        inserted++;
    }

    // 统计三张表行数
    const [r1] = await conn.query('SELECT COUNT(*) AS n FROM kc_entitlement_rules');
    const [r2] = await conn.query('SELECT COUNT(*) AS n FROM kc_entitlement_grants');
    const [r3] = await conn.query('SELECT COUNT(*) AS n FROM kc_entitlement_uses');
    console.log(JSON.stringify({
        inserted, reused,
        rules: r1[0].n, grants: r2[0].n, uses: r3[0].n
    }, null, 2));
    await conn.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
