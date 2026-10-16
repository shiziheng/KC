// ⚠️ 已退役（v2.1.0 · Xboard 代码摘除）：本文件属 Xboard 时代工具链，仅作历史/回滚参考，日常开发与部署不再使用。
#!/usr/bin/env node
/**
 * tools/kc-seed-entitlement-rules.js
 *
 * 权益包 → KC 权益规则种子（幂等）。
 *
 * 设计：Xboard 后台录入的「权益包商品」（v2_plan.kc_card.category='entitlement'）
 *      只是**售卖入口**；真正决定「代充便宜多少、能用几次」的规则在 KC 侧。
 *      本脚本把两者按 pack_key ↔ 规则 code 对应起来：
 *         权益包套餐 plan_id  →  plan_code = xplan_<plan_id>
 *         KC 规则 source='purchase' + trigger_plan_code=xplan_<plan_id>
 *         → 用户下单该权益包并通过支付后，插件回调 KC 自动发放 grant（N 次、按权益价）
 *
 * 定价口径（与 tools/xboard-pack-seed.php 一致）：代充市场价 $20/次，权益价 $12/次（6 折）。
 *
 * 幂等：code 已存在则 UPDATE（反复执行结果一致）。
 *
 * 用法：node tools/kc-seed-entitlement-rules.js
 */
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
        host: env.MYSQL_HOST || '127.0.0.1',
        port: parseInt(env.MYSQL_PORT || '3310', 10),
        user: env.MYSQL_USER || 'root',
        password: env.MYSQL_ROOT_PASSWORD || env.MYSQL_PASSWORD || env.DB_PASSWORD || '',
        database: 'plus_papay',
        ssl: false,
        multipleStatements: true,
    });

    // 1) 从 xboard 库读出所有权益包套餐（跨库查询，同一 MySQL 实例）
    const [plans] = await conn.query(
        "SELECT id, name, kc_card FROM `xboard`.`v2_plan` " +
        "WHERE kc_card IS NOT NULL AND JSON_EXTRACT(kc_card, '$.category') = 'entitlement'"
    );
    if (!plans.length) {
        console.log('未找到权益包套餐（先在 Xboard 侧跑 tools/xboard-pack-seed.php）。');
        await conn.end();
        return;
    }

    let inserted = 0, updated = 0;
    for (const p of plans) {
        let card = {};
        try { card = typeof p.kc_card === 'string' ? JSON.parse(p.kc_card) : (p.kc_card || {}); } catch (e) { card = {}; }
        const key = String(card.pack_key || ('pack' + p.id));
        const times = Math.max(1, parseInt(card.times, 10) || 1);
        const packName = String(card.pack_name || p.name || ('权益包 ' + key));
        const code = ('pack_' + key + '_off40').slice(0, 64);
        const planCode = 'xplan_' + p.id;
        const displayName = (packName + ' · 代充 6 折').slice(0, 128);

        const row = [
            code,
            displayName,
            JSON.stringify([]),      // 空 = 全部代充 plan 适用
            'percent',
            40,                      // 6 折：$20 → $12
            0,
            times,                   // 权益次数 = 包内次数
            180,                     // 180 天有效
            100,
            'active',
            'purchase',
            planCode,                // 买这个权益包 → 触发发权益
            null,
            null,
            `权益包 ${key}：购买后发放 ${times} 次「代充 6 折」权益（180 天）。由 tools/kc-seed-entitlement-rules.js 写入。`
        ];

        const [exist] = await conn.query('SELECT id FROM kc_entitlement_rules WHERE code=?', [code]);
        if (exist.length) {
            await conn.query(
                'UPDATE kc_entitlement_rules SET display_name=?, plan_scope=?, discount_type=?, discount_value=?, ' +
                'min_order_cents=?, grant_uses=?, grant_period_days=?, priority=?, status=?, source=?, ' +
                'trigger_plan_code=?, valid_from=?, valid_until=?, note=? WHERE code=?',
                row.slice(1).concat([code])
            );
            updated++;
        } else {
            await conn.query(
                'INSERT INTO kc_entitlement_rules (code, display_name, plan_scope, discount_type, discount_value, ' +
                'min_order_cents, grant_uses, grant_period_days, priority, status, source, trigger_plan_code, ' +
                'valid_from, valid_until, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                row
            );
            inserted++;
        }
        console.log(`RULE ${code}  ←  ${planCode} (${packName}, ${times} 次)`);
    }

    const [rules] = await conn.query('SELECT COUNT(*) AS n FROM kc_entitlement_rules');
    console.log(JSON.stringify({ inserted, updated, rules_total: rules[0].n }, null, 2));
    await conn.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
