// ⚠️ 已退役（v2.1.0 · Xboard 代码摘除）：本文件属 Xboard 时代工具链，仅作历史/回滚参考，日常开发与部署不再使用。
#!/usr/bin/env node
// v1.15.0 · 上游接入层数据回填脚本（幂等）
// 用法：node tools/migrate-upstreams.js
// 行为：
//   1) 若 kc_upstreams 不存在，则创建（兼容未启动服务的情况）
//   2) 写入一个 mock_zovo 上游（display_name 显示，且 status=active）
//   3) 写入 12 条 mock 上游目录（与 zovocard-client.js MOCK_PLANS 字段一致）
//   4) 读取 xboard.v2_plugins.config 的 packages 映射作为「计划 → 上游套餐键」参考
//   5) 输出回填报告（不修改 v2_plugins.config；插件读法切换留待 R3）
//
// 幂等：所有 INSERT 都使用 ON DUPLICATE KEY UPDATE；可重跑。

const fs = require('fs');
const path = require('path');

// 本机运行支持：从 .env 加载 DB 配置；本机 Docker 映射端口 3310（容器内运行时受 compose env 覆盖，不受影响）
const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
    for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}
if (!process.env.DB_PORT) process.env.DB_PORT = '3310';

// 复用 KC 引擎的 mysql-store
const mysqlStore = require(path.join(ROOT, 'mysql-store'));

const MOCK_PLANS = [
    { key: 'go', name: 'ChatGPT Go', sku_type: 'subscription', period: 'month', is_credit: 0, requires_active_subscription: 0, enabled: 1 },
    { key: 'plus', name: 'ChatGPT Plus', sku_type: 'subscription', period: 'month', is_credit: 0, requires_active_subscription: 0, enabled: 1 },
    { key: 'pro_5x', name: 'ChatGPT Pro (5x)', sku_type: 'subscription', period: 'month', is_credit: 0, requires_active_subscription: 0, enabled: 1 },
    { key: 'pro_20x', name: 'ChatGPT Pro (20x)', sku_type: 'subscription', period: 'month', is_credit: 0, requires_active_subscription: 0, enabled: 1 },
    { key: 'pro_50x', name: 'ChatGPT Pro (50x)', sku_type: 'subscription', period: 'month', is_credit: 0, requires_active_subscription: 0, enabled: 1 },
    { key: 'pro_20x_renew', name: 'Pro 20x Renewal (card-attach)', sku_type: 'subscription', period: 'month', is_credit: 0, requires_active_subscription: 1, enabled: 1 },
    ...[250, 500, 1000, 2500, 5000, 25000].map(function (credits) {
        return {
            key: 'credit' + credits,
            name: 'Codex Credits ' + credits.toLocaleString('en-US'),
            sku_type: 'credit',
            period: 'once',
            is_credit: 1,
            requires_active_subscription: 1,
            enabled: 1
        };
    })
];

(async function main() {
    await mysqlStore.ensureReady();
    console.log('ensureReady done');

    // 1) 上游身份：mock_zovo（幂等）
    await mysqlStore.runExecute(
        'INSERT INTO kc_upstreams (code, display_name, protocol, status, base_url, api_key_ref, note) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), status = VALUES(status), note = VALUES(note)',
        ['mock_zovo', 'ZovoCard (Mock)', 'mock', 'active', '', 'ZOVOCARD_API_KEY',
            'v1.15.0 回填：与 zovocard-client.js MOCK 模式一致；切换上游时新增 code，不修改本行']
    );
    console.log('upsert upstream: mock_zovo');

    // 2) 上游目录：12 条（幂等）
    for (const p of MOCK_PLANS) {
        await mysqlStore.runExecute(
            'INSERT INTO kc_upstream_plans (upstream_code, upstream_plan_key, display_name, sku_type, period, upstream_price_cents, currency, is_credit, requires_active_subscription, enabled, note) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), sku_type = VALUES(sku_type), period = VALUES(period), ' +
            'is_credit = VALUES(is_credit), requires_active_subscription = VALUES(requires_active_subscription), enabled = VALUES(enabled)',
            ['mock_zovo', p.key, p.name, p.sku_type, p.period, 0, 'USD', p.is_credit, p.requires_active_subscription, p.enabled, '回填自 zovocard-client.js MOCK']
        );
    }
    console.log('upsert upstream plans: ' + MOCK_PLANS.length);

    // 3) 读取 xboard 插件 config.packages 作为参考（不动）
    let pkgSummary = { source: 'not-found', plans: 0 };
    try {
        const cfg = await mysqlStore.runQuery("SELECT config FROM xboard.v2_plugins WHERE code = ? LIMIT 1", ['kc_integration']);
        if (cfg.length && cfg[0].config) {
            let obj = cfg[0].config;
            try { obj = JSON.parse(obj); } catch (e) { obj = null; }
            if (obj && obj.packages && typeof obj.packages === 'object') {
                const arr = Object.entries(obj.packages);
                pkgSummary = {
                    source: 'xboard.v2_plugins.config.packages',
                    plans: arr.length,
                    plan_ids_to_keyed: arr.map(function ([pid, key]) { return pid + '→' + key; }).join(', ')
                };
            }
        }
    } catch (e) {
        pkgSummary = { source: 'error', error: String(e.message || e).slice(0, 200) };
    }

    // 4) 健康快照：写入首条 healthy（用于列表显示）
    await mysqlStore.runExecute(
        'INSERT INTO kc_upstream_health_snapshots (upstream_code, state, reason, failure_count, last_probe_status, last_probe_reason_code, manual_override, mock) ' +
        'VALUES (?, ?, ?, 0, ?, ?, 0, 1)',
        ['mock_zovo', 'healthy', '回填：mock_zovo 默认 healthy；手动刷健康调用 /api/admin/upstreams/:code/health/refresh', 'mock_seed', 'mock_healthy']
    );

    // 5) 输出报告
    const rows = await mysqlStore.runQuery('SELECT upstream_plan_key, sku_type, period, enabled FROM kc_upstream_plans WHERE upstream_code = ? ORDER BY id', ['mock_zovo']);
    const ups = await mysqlStore.runQuery('SELECT code, display_name, status FROM kc_upstreams ORDER BY code');
    const out = {
        ok: true,
        upstreams: ups.map(function (r) { return { code: r.code, display_name: r.display_name, status: r.status }; }),
        upstream_plans: rows.map(function (r) { return { upstream_plan_key: r.upstream_plan_key, sku_type: r.sku_type, period: r.period, enabled: !!Number(r.enabled) }; }),
        packages_reference: pkgSummary,
        note: 'plugins.config.packages 未修改，切换读法留待 R3'
    };
    fs.writeFileSync(path.join(ROOT, 'logs', 'migrate-upstreams-report.json'), JSON.stringify(out, null, 2));
    console.log('\n=== 回填报告 ===');
    console.log(JSON.stringify(out, null, 2));
    console.log('\n报告已落 logs/migrate-upstreams-report.json');
    process.exit(0);
})().catch(function (err) {
    console.error('FAILED:', err && err.stack || err);
    process.exit(1);
});