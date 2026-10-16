// ⚠️ 已退役（v2.1.0 · Xboard 代码摘除）：本文件属 Xboard 时代工具链，仅作历史/回滚参考，日常开发与部署不再使用。
#!/usr/bin/env node
// v1.17.0 · 展示层数据回填脚本（幂等）
// 用法：node tools/migrate-listing-cards.js
// 行为：
//   1) 读 xboard.v2_plan.kc_card（按 plan 顺序）
//   2) 按 kc_plans.code='xplan_<v2id>' 建立映射
//   3) 写入 kc_listing_cards（card_json + 默认 is_visible=1 + listing_state='onsale' + sort=原 v2_plan.sort）
//   4) 输出报告；INSERT ... ON DUPLICATE KEY UPDATE 幂等可重跑
//
// 注意：v2_plan.kc_card 不动；本脚本只回填到 KC 侧新表

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

    // 1) 读所有 v2_plan 行（带 kc_card + sort）
    const [v2plans] = await xb.query(
        "SELECT id, kc_card, `show`, sell, sort FROM v2_plan ORDER BY sort, id"
    );

    // 2) 读 kc_plans 的 code → id 映射
    const [kcPlans] = await kc.query("SELECT id, code FROM kc_plans");
    const codeMap = {};
    kcPlans.forEach(p => { codeMap[p.code] = p.id; });

    const report = { cards: [], errors: [], skipped: [] };
    let inserted = 0, updated = 0;
    for (const v of v2plans) {
        const code = 'xplan_' + v.id;
        const plan_id = codeMap[code];
        if (!plan_id) {
            report.skipped.push({ v2_plan_id: v.id, reason: 'kc_plans 中无对应 code=' + code });
            continue;
        }
        // 解析 v2_plan.kc_card（已配置就用，未配置用默认）
        let card = null;
        if (v.kc_card && String(v.kc_card).trim()) {
            try { card = JSON.parse(v.kc_card); } catch (e) { card = null; }
        }
        const card_json = card ? JSON.stringify(card) : JSON.stringify({
            state: (v.show && v.sell) ? 'onsale' : 'soon',
            badge: { text: '', pos: 'left', color: 'brand' },
            title: '', subtitle: '',
            price: { mode: 'auto', value: null, unit: '/月', tag: '' },
            promo: { enabled: true, strike: '', text: '' },
            type: { text: '', color: 'brand' },
            features: [], guarantees: [], tip: '',
            button: { text: '立即订阅', style: 'solid' },
            chips: []
        });
        const is_visible = (v.show && v.sell) ? 1 : 0;
        const listing_state = (v.show && v.sell) ? 'onsale' : 'soon';
        const sort = Number(v.sort) || 0;

        // 3) upsert（按 plan_id）
        const [before] = await kc.query('SELECT plan_id FROM kc_listing_cards WHERE plan_id=?', [plan_id]);
        await kc.query(
            'INSERT INTO kc_listing_cards (plan_id, card_json, is_visible, listing_state, sort) VALUES (?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE card_json=VALUES(card_json), is_visible=VALUES(is_visible), listing_state=VALUES(listing_state), sort=VALUES(sort)',
            [plan_id, card_json, is_visible, listing_state, sort]
        );
        if (before.length) updated++; else inserted++;
        report.cards.push({ v2_plan_id: v.id, plan_id, has_custom_card: !!card, is_visible, listing_state, sort });
    }

    const summary = {
        ok: report.errors.length === 0,
        total: v2plans.length,
        inserted, updated,
        skipped: report.skipped.length,
        skippedDetail: report.skipped.slice(0, 10),
        note: 'v2_plan.kc_card 未修改；本脚本只回填 KC 侧 kc_listing_cards；切换读法留待插件改读'
    };
    fs.writeFileSync(path.join(ROOT, 'logs', 'migrate-listing-cards-report.json'), JSON.stringify({ summary, cards: report.cards.slice(0, 30) }, null, 2));
    console.log('=== 展示层回填报告 ===');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\n报告：logs/migrate-listing-cards-report.json');

    await xb.end();
    await kc.end();
    process.exit(summary.ok ? 0 : 1);
})().catch(function (err) {
    console.error('FAILED:', err && err.stack || err);
    process.exit(1);
});