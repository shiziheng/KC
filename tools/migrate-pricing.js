// ⚠️ 已退役（v2.1.0 · Xboard 代码摘除）：本文件属 Xboard 时代工具链，仅作历史/回滚参考，日常开发与部署不再使用。
#!/usr/bin/env node
// v1.16.0 · 资费层数据回填脚本（幂等）
// 用法：node tools/migrate-pricing.js
// 行为：
//   1) 读 xboard.v2_plan（订阅类 is_topup=0 + 充值类 is_topup=1）
//   2) 读 v2_plugins.config.packages（plan_id → mock_zovo 上游套餐键）
//   3) 写入 kc_plans（code='xplan_<id>'，订阅绑上游键，充值不绑）
//   4) 写入 kc_pricing_rules：订阅类 source=manual/period=month/amount_cents=prices.monthly×100；
//      充值类 source=manual/period=once/amount_cents=kc_topup_amount（已是分）
//   5) 输出报告；所有 INSERT 走 ON DUPLICATE KEY UPDATE 幂等可重跑
//
// 不动 v2_plan.prices / kc_topup_amount；切换读法留 R3。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = {};
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise'));

(async function main() {
    const xb = await mysql.createConnection({
        host: '127.0.0.1', port: 3310,
        user: env.MYSQL_USER || 'root',
        password: env.MYSQL_ROOT_PASSWORD || env.MYSQL_PASSWORD || env.DB_PASSWORD || '',
        database: 'xboard', ssl: false
    });
    const kc = await mysql.createConnection({
        host: '127.0.0.1', port: 3310,
        user: env.MYSQL_USER || 'root',
        password: env.MYSQL_ROOT_PASSWORD || env.MYSQL_PASSWORD || env.DB_PASSWORD || '',
        database: 'plus_papay', ssl: false
    });

    // 1) 读 packages 映射（字符串内嵌 JSON）
    const [cfgRows] = await xb.query("SELECT config FROM v2_plugins WHERE code='kc_integration' LIMIT 1");
    let packages = {};
    if (cfgRows[0] && cfgRows[0].config) {
        const c = cfgRows[0].config;
        if (c.packages) {
            try { packages = typeof c.packages === 'string' ? JSON.parse(c.packages) : (c.packages || {}); } catch (e) { packages = {}; }
        }
    }

    // 2) 读 v2_plan 全部
    const [plans] = await xb.query(
        "SELECT id, name, prices, kc_is_topup, kc_topup_amount, `show`, sell FROM v2_plan ORDER BY sort, id"
    );

    const report = { plans: [], errors: [] };
    for (const p of plans) {
        let prices = {};
        try { prices = typeof p.prices === 'string' ? JSON.parse(p.prices || '{}') : (p.prices || {}); } catch (e) { prices = {}; }
        const isTopup = Number(p.kc_is_topup || 0) === 1;
        const code = 'xplan_' + p.id;
        const kc_type = isTopup ? 'recharge' : 'recharge'; // R2 暂不分 account/entitlement（按 SP §3.2 复用 v1.0.0）
        const upstream_key = packages[String(p.id)] || '';
        const upstream_code = upstream_key ? 'mock_zovo' : '';
        const display_name = p.name || ('Plan ' + p.id);

        // 3) upsert kc_plans
        await kc.query(
            'INSERT INTO kc_plans (code, kc_type, display_name, upstream_code, upstream_plan_key, status, note) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE kc_type=VALUES(kc_type), display_name=VALUES(display_name), ' +
            'upstream_code=VALUES(upstream_code), upstream_plan_key=VALUES(upstream_plan_key), status=VALUES(status)',
            [code, kc_type, display_name, upstream_code, upstream_key, (p.show && p.sell) ? 'active' : 'paused', 'v1.16.0 回填自 v2_plan id=' + p.id]
        );

        // 4) 写一条 manual 规则
        let amount_cents = 0, period = 'once';
        if (isTopup) {
            amount_cents = Math.floor(Number(p.kc_topup_amount) || 0);
            period = 'once';
        } else if (prices.monthly) {
            amount_cents = Math.round(Number(prices.monthly) * 100);
            period = 'month';
        } else {
            // 其他周期暂跳过
            continue;
        }
        if (amount_cents <= 0) continue;

        // 取刚 upsert 的 plan id
        const [[row]] = await kc.query('SELECT id FROM kc_plans WHERE code=?', [code]);
        const plan_id = row && row.id;

        // 先删后插（按 plan × source × period 唯一）
        await kc.query('DELETE FROM kc_pricing_rules WHERE plan_id=? AND source=? AND period=?', [plan_id, 'manual', period]);
        await kc.query(
            'INSERT INTO kc_pricing_rules (plan_id, source, period, amount_cents, priority, enabled, note) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            [plan_id, 'manual', period, amount_cents, 0, 1, 'v1.16.0 回填自 v2_plan.prices']
        );

        report.plans.push({
            v2_plan_id: p.id, code, kc_type, display_name,
            upstream: upstream_code + '/' + upstream_key || '(none)',
            amount_cents, period
        });
    }

    // 6) 报告
    const summary = {
        ok: report.errors.length === 0,
        planCount: report.plans.length,
        rulesCount: report.plans.length,
        plans: report.plans,
        packages_reference: packages,
        note: 'v2_plan.prices / kc_topup_amount 未修改；切换读法留 R3'
    };
    fs.writeFileSync(path.join(ROOT, 'logs', 'migrate-pricing-report.json'), JSON.stringify(summary, null, 2));
    console.log('=== 回填报告 ===');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\n报告：logs/migrate-pricing-report.json');

    await xb.end();
    await kc.end();
    process.exit(summary.ok ? 0 : 1);
})().catch(function (err) {
    console.error('FAILED:', err && err.stack || err);
    process.exit(1);
});