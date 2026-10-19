#!/usr/bin/env node
/**
 * tools/check-functional-suite.js
 * ------------------------------------------------------------------
 * KC 直供主站 · 功能回归测试套件（v2.0.0 · 上线前全量功能验收）
 *
 * 覆盖用户指定的 9 项核心功能：
 *   1 登录        2 注册        3 创建商品      4 维护报价
 *   5 买代充商品  6 买权益包    7 买/兑 CDK     8 充值        9 查订单
 * 另含：售后、越权、幂等、负向用例。
 *
 * 用法：node tools/check-functional-suite.js
 * 退出码：0=全部通过；1=有 FAIL
 *
 * 前提：服务已运行（http://localhost:3100），.env 内 ADMIN_EMAIL/ADMIN_PASSWORD 可用。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.KC_BASE || 'http://localhost:3100';
const ROOT = path.resolve(__dirname, '..');

// 读 .env（管理员凭证）
function env(key, def) {
    if (process.env[key]) return process.env[key];
    try {
        const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
        const m = raw.match(new RegExp('^' + key + '=(.*)$', 'm'));
        if (m) return m[1].trim();
    } catch (e) { /* ignore */ }
    return def;
}
const ADMIN_EMAIL = env('ADMIN_EMAIL', '');
const ADMIN_PASSWORD = env('ADMIN_PASSWORD', '');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; const d = String(extra == null ? '' : extra).slice(0, 220); failures.push(name + ' :: ' + d); console.log('  [FAIL] ' + name + (d ? '  | ' + d : '')); }
}

async function j(method, p, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (opts.ct) headers['X-Customer-Token'] = opts.ct;
    if (opts.at) headers['Authorization'] = 'Bearer ' + opts.at;
    const r = await fetch(BASE + p, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let jj = {}; try { jj = await r.json(); } catch (e) { }
    return { status: r.status, body: jj };
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

(async () => {
    console.log('=== KC 直供 · 功能回归测试套件 ===  base=' + BASE + '\n');

    // ── F1 管理员登录 ──
    console.log('F1 · 管理员登录');
    const login = await j('POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    const adminToken = login.body.token || (login.body.data && (login.body.data.token || login.body.data.access_token));
    ok('F1.1 管理员登录 200 且签发令牌', login.status === 200 && !!adminToken, JSON.stringify(login.body).slice(0, 200));
    if (!adminToken) {
        console.log('\n  ⚠ 无管理员令牌，后台类用例（F2/F3/F4/F5/F7.4）无法执行 —— 请确认 ADMIN_EMAIL/ADMIN_PASSWORD 及是否启用二次验证。');
    }

    // ── F2 创建商品 ──
    console.log('F2 · 创建商品（后台）');
    const prodName = '功能测试商品 ' + uid();
    const save = await j('POST', '/api/admin/products/save', { at: adminToken, body: {
        name: prodName, price: 12.34, period: 'onetime', show: 1, sell: 1, is_topup: 1, api_enabled: 0, content: '自动化测试创建'
    } });
    const newPlanId = save.body.data && save.body.data.plan_id;
    ok('F2.1 新建商品 200 且返回 plan_id', save.status === 200 && !!newPlanId, JSON.stringify(save.body).slice(0, 200));
    const prods = await j('GET', '/api/admin/products', { at: adminToken });
    const hit = (prods.body.data || prods.body.items || []).find(x => String(x.name) === prodName || String(x.id) === String(newPlanId));
    ok('F2.2 商品列表可见新建商品', !!hit, JSON.stringify(prods.body).slice(0, 200));
    if (newPlanId) {
        const patch = await j('PATCH', '/api/admin/plans/' + newPlanId, { at: adminToken, body: { note: '功能测试更新备注' } });
        ok('F2.3 更新商品(SKU)成功', patch.status === 200, JSON.stringify(patch.body).slice(0, 160));
    }

    // ── F3 商品可见性（listing card）──
    console.log('F3 · 商品上架/可见性');
    const kcPlans = await j('GET', '/api/admin/plans', { at: adminToken });
    const kcPlan = (kcPlans.body.items || []).find(x => String(x.id) === String(newPlanId));
    const kcPlanId = kcPlan && kcPlan.id;
    if (kcPlanId) {
        const card = await j('PUT', '/api/admin/listing-cards/' + kcPlanId, { at: adminToken, body: {
            is_visible: false, listing_state: 'soon', sort: 998,
            card: { category: 'recharge', state: 'soon', title: prodName, subtitle: '', features: [], guarantees: [] }
        } });
        ok('F3.1 保存上架卡片成功', card.status === 200, JSON.stringify(card.body).slice(0, 160));
        const vis = await j('POST', '/api/admin/listing-cards/' + kcPlanId + '/visibility', { at: adminToken, body: { is_visible: true } });
        ok('F3.2 切换可见性成功', vis.status === 200, JSON.stringify(vis.body).slice(0, 160));
    } else ok('F3.x 依赖 F2.1（跳过）', false, 'no kc_plans id');

    // ── F4 维护报价（权益包×商品 一口价）──
    console.log('F4 · 维护报价（后台保单）');
    const setp = await j('POST', '/api/admin/entitlements/prices', { at: adminToken, body: { rule_code: 'pack_light_off40', items: [{ plan_code: 'xplan_1', price_cents: 900 }] } });
    ok('F4.1 保存逐商品报价 200', setp.status === 200 && setp.body.data && setp.body.data.saved >= 1, JSON.stringify(setp.body).slice(0, 200));
    const rd = await j('GET', '/api/admin/entitlements/prices?rule_code=pack_light_off40', { at: adminToken });
    const p1 = (rd.body.data && rd.body.data.products || []).find(x => x.plan_code === 'xplan_1');
    ok('F4.2 回读报价 = 900 分（$9.00）', !!p1 && Number(p1.price_cents) === 900, JSON.stringify(p1));

    // ── F5 权益包售价（前台可售）──
    console.log('F5 · 权益包售价（后台）');
    const packPrice = await j('POST', '/api/admin/entitlements/packs/pack_light_off40/price', { at: adminToken, body: { sale_price_cents: 6000 } });
    ok('F5.1 设置权益包售价 200 且可售', packPrice.status === 200 && packPrice.body.data && packPrice.body.data.sellable === true, JSON.stringify(packPrice.body).slice(0, 200));
    const packs = await j('GET', '/api/tenant/packs', {});
    const pk = (packs.body.data || []).find(x => x.code === 'pack_light_off40');
    ok('F5.2 前台可售权益包列表含 pack_light_off40（$60.00）', !!pk && Number(pk.price) === 60, JSON.stringify(pk));

    // ── F6 注册 ──
    console.log('F6 · 顾客注册');
    const email = 'func_' + uid() + '@example.com';
    const PW = 'KcTest@2026';
    const reg = await j('POST', '/api/tenant/auth/register', { body: { email, password: PW } });
    const token = reg.body.data && reg.body.data.token;
    ok('F6.1 注册 200 且签发令牌', reg.status === 200 && !!token, JSON.stringify(reg.body).slice(0, 200));
    const regDup = await j('POST', '/api/tenant/auth/register', { body: { email, password: PW } });
    ok('F6.2 重复注册被拒（非 200）', regDup.status !== 200, 'status=' + regDup.status);
    const regBad = await j('POST', '/api/tenant/auth/register', { body: { email: '', password: '' } });
    ok('F6.3 空邮箱/密码被拒（400）', regBad.status === 400, 'status=' + regBad.status);

    // ── F7 登录 ──
    console.log('F7 · 顾客登录 / 会话');
    const lg = await j('POST', '/api/tenant/auth/login', { body: { email, password: PW } });
    const ltoken = lg.body.data && lg.body.data.token;
    ok('F7.1 登录 200 且签发令牌', lg.status === 200 && !!ltoken, JSON.stringify(lg.body).slice(0, 200));
    const lgBad = await j('POST', '/api/tenant/auth/login', { body: { email, password: 'wrong-pw' } });
    ok('F7.2 错误密码被拒（非 200）', lgBad.status !== 200, 'status=' + lgBad.status);
    const me = await j('GET', '/api/tenant/auth/me', { ct: ltoken });
    ok('F7.3 会话 me 命中本人 email', me.status === 200 && me.body.data && me.body.data.customer && me.body.data.customer.email === email, JSON.stringify(me.body).slice(0, 200));
    if (adminToken) {
        const noTok = await j('GET', '/api/admin/products', {});
        ok('F7.4 无管理员令牌访问后台被拒（401）', noTok.status === 401, 'status=' + noTok.status);
    }

    // ── F8 商品目录 ──
    console.log('F8 · 商品目录');
    const catGuest = await j('GET', '/api/tenant/catalog', {});
    ok('F8.1 访客目录 200 且含 xplan_1', catGuest.status === 200 && (catGuest.body.data || []).some(x => x.sku === 'xplan_1'), JSON.stringify(catGuest.body).slice(0, 240));
    const x1g = (catGuest.body.data || []).find(x => x.sku === 'xplan_1');
    ok('F8.2 访客无权益价（entitlement_price=null）', !!x1g && (x1g.entitlement_price == null), JSON.stringify(x1g));

    // ── F9 充值 ──
    console.log('F9 · 充值（模拟收款回调）');
    const rc = await j('POST', '/api/tenant/wallet/recharge', { ct: ltoken, body: { amount_cents: 20000 } });
    const rcNo = rc.body.data && rc.body.data.recharge_no;
    ok('F9.1 发起充值 200（生成收款地址，不入账）', rc.status === 200 && !!rcNo && !!rc.body.data.pay_address, JSON.stringify(rc.body).slice(0, 200));
    const rcBad = await j('POST', '/api/tenant/wallet/recharge', { ct: ltoken, body: { amount_cents: 10 } });
    ok('F9.2 低于最小充值额被拒（400）', rcBad.status === 400, 'status=' + rcBad.status);
    const cf = await j('POST', '/api/tenant/wallet/recharge/confirm', { ct: ltoken, body: { recharge_no: rcNo } });
    ok('F9.3 收款回调入账 200 且 credited=true', cf.status === 200 && cf.body.data && cf.body.data.credited === true, JSON.stringify(cf.body).slice(0, 200));
    const cf2 = await j('POST', '/api/tenant/wallet/recharge/confirm', { ct: ltoken, body: { recharge_no: rcNo } });
    ok('F9.4 重复回调幂等（credited=false，不重复入账）', cf2.status === 200 && cf2.body.data && cf2.body.data.credited === false, JSON.stringify(cf2.body).slice(0, 200));
    const w1 = await j('GET', '/api/tenant/wallet', { ct: ltoken });
    ok('F9.5 钱包余额 = $200.00', w1.body.data && Number(w1.body.data.balance) === 200, JSON.stringify(w1.body.data && w1.body.data.balance));

    // ── F10 买代充商品（原价下单）──
    console.log('F10 · 买代充商品（原价下单 → 发卡 → 查订单）');
    const q1 = await j('POST', '/api/tenant/quote', { ct: ltoken, body: { sku: 'xplan_1', qty: 1 } });
    const quote1 = q1.body.data && q1.body.data.quote_id;
    ok('F10.1 报价 200 含 quote_id 且无权益价', q1.status === 200 && !!quote1 && q1.body.data.entitlement_price == null, JSON.stringify(q1.body).slice(0, 220));
    const o1 = await j('POST', '/api/tenant/orders', { ct: ltoken, body: { quote_id: quote1, client_order_no: 'func_' + uid() } });
    const orderNo = o1.body.data && o1.body.data.order_id;
    ok('F10.2 下单 200 返回 order_id', o1.status === 200 && !!orderNo, JSON.stringify(o1.body).slice(0, 220));
    const w2 = await j('GET', '/api/tenant/wallet', { ct: ltoken });
    ok('F10.3 钱包已扣款（余额 < 200）', w2.body.data && Number(w2.body.data.balance) < 200, JSON.stringify(w2.body.data && w2.body.data.balance));

    // ── F11 查订单 ──
    console.log('F11 · 查订单');
    const list1 = await j('GET', '/api/tenant/orders', { ct: ltoken });
    const row1 = (list1.body.data || []).find(x => x.order_id === orderNo);
    ok('F11.1 订单列表命中本单', !!row1, JSON.stringify(list1.body).slice(0, 240));
    ok('F11.2 订单状态 = delivered（已完成）', !!row1 && row1.status === 'delivered', JSON.stringify(row1));
    const cdk = row1 && row1.cdk;
    ok('F11.3 已发卡（返回 cdk）', !!cdk, JSON.stringify(row1 && { status: row1.status, cdk: row1.cdk }));
    ok('F11.4 金额为 $ 数字单位', !!row1 && typeof row1.amount === 'number', JSON.stringify(row1 && row1.amount));

    // ── F12 兑 CDK ──
    console.log('F12 · 兑卡（CDK）');
    if (cdk) {
        const v = await j('POST', '/api/verify-cdk', { body: { cdk } });
        ok('F12.1 有效卡密校验 200 + success', v.status === 200 && v.body.success === true, JSON.stringify(v.body).slice(0, 220));
        ok('F12.2 识别套餐名（plan_label）', !!(v.body.data && v.body.data.plan_label), JSON.stringify(v.body.data || {}).slice(0, 180));
    } else ok('F12.x 依赖 F11.3（跳过）', false, 'no cdk');
    const vBad = await j('POST', '/api/verify-cdk', { body: { cdk: 'KC-ZZZZZZZZZZZZZZZ' } });
    ok('F12.3 无效卡密被拒（非 200 或无 success）', !(vBad.status === 200 && vBad.body.success === true), JSON.stringify(vBad.body).slice(0, 200));
    const vEmpty = await j('POST', '/api/verify-cdk', { body: { cdk: '' } });
    ok('F12.4 空卡密被拒（400）', vEmpty.status === 400, 'status=' + vEmpty.status);

    // ── F13 买权益包 ──
    console.log('F13 · 买权益包（顾客钱包扣款开通）');
    const ref = 'fpk_' + uid();
    const buy = await j('POST', '/api/tenant/packs/purchase', { ct: ltoken, body: { pack_code: 'pack_light_off40', client_ref: ref } });
    ok('F13.1 开通权益包 200 且未复用', buy.status === 200 && buy.body.data && buy.body.data.reused !== true, JSON.stringify(buy.body).slice(0, 240));
    const buy2 = await j('POST', '/api/tenant/packs/purchase', { ct: ltoken, body: { pack_code: 'pack_light_off40', client_ref: ref } });
    ok('F13.2 同 client_ref 幂等复用（reused=true）', buy2.status === 200 && buy2.body.data && buy2.body.data.reused === true, JSON.stringify(buy2.body).slice(0, 200));
    const ent = await j('GET', '/api/tenant/entitlements', { ct: ltoken });
    const hasPack = (ent.body.data || []).find(x => x.rule_code === 'pack_light_off40');
    ok('F13.3 我的权益含 pack_light_off40 且剩余次数=5', !!hasPack && Number(hasPack.remaining_uses) === 5, JSON.stringify(hasPack));
    const buy3 = await j('POST', '/api/tenant/packs/purchase', { ct: ltoken, body: { pack_code: 'pack_light_off40', client_ref: 'fpk2_' + uid() } });
    ok('F13.4 已持有生效权益 → 拒绝重复开通（409）', buy3.status === 409, 'status=' + buy3.status);

    // ── F14 权益价下单（双价 + 扣次）──
    console.log('F14 · 权益价下单（G7 双价结算 + 扣次）');
    const cat2 = await j('GET', '/api/tenant/catalog', { ct: ltoken });
    const x1 = (cat2.body.data || []).find(x => x.sku === 'xplan_1');
    ok('F14.1 登录后目录带权益价 $9.00', !!x1 && Number(x1.entitlement_price) === 9, JSON.stringify(x1));
    const q2 = await j('POST', '/api/tenant/quote', { ct: ltoken, body: { sku: 'xplan_1', qty: 1 } });
    ok('F14.2 报价锁权益价 unit_price=$9.00', q2.status === 200 && Number(q2.body.data.unit_price) === 9, JSON.stringify(q2.body.data || {}).slice(0, 200));
    const o2 = await j('POST', '/api/tenant/orders', { ct: ltoken, body: { quote_id: q2.body.data.quote_id, client_order_no: 'func_ent_' + uid() } });
    ok('F14.3 权益价下单 200', o2.status === 200 && o2.body.data && o2.body.data.order_id, JSON.stringify(o2.body).slice(0, 220));
    const ent2 = await j('GET', '/api/tenant/entitlements', { ct: ltoken });
    const hp2 = (ent2.body.data || []).find(x => x.rule_code === 'pack_light_off40');
    ok('F14.4 交付成功后扣 1 次（剩余 5→4）', !!hp2 && Number(hp2.remaining_uses) === 4, JSON.stringify(hp2));

    // ── F15 售后 ──
    console.log('F15 · 订单售后');
    const as = await j('POST', '/api/tenant/after-sales', { ct: ltoken, body: { order_no: orderNo, request_type: 'other', message: '功能测试：自动化提交售后' } });
    ok('F15.1 提交售后 200 且 status=open', as.status === 200 && as.body.data && as.body.data.status === 'open', JSON.stringify(as.body).slice(0, 200));
    const asBad = await j('POST', '/api/tenant/after-sales', { ct: ltoken, body: { order_no: 'NOT_EXIST_' + uid(), request_type: 'refund', message: 'x' } });
    ok('F15.2 非本人订单售后被拒（404）', asBad.status === 404, 'status=' + asBad.status);
    const asEmpty = await j('POST', '/api/tenant/after-sales', { ct: ltoken, body: { order_no: orderNo, message: '' } });
    ok('F15.3 空描述被拒（400）', asEmpty.status === 400, 'status=' + asEmpty.status);

    // ── F16 买/兑 CDK（后台发卡 → 前台兑）──
    console.log('F16 · 后台生成 CDK → 前台兑卡');
    if (adminToken) {
        const gen = await j('POST', '/api/admin/cdks/generate', { at: adminToken, body: { count: 1, plan_type: 'plus' } });
        const genCdk = gen.body.cdks && gen.body.cdks[0];
        ok('F16.1 后台生成 CDK 200', gen.status === 200 && !!genCdk, JSON.stringify(gen.body).slice(0, 200));
        if (genCdk) {
            const v2 = await j('POST', '/api/verify-cdk', { body: { cdk: genCdk } });
            ok('F16.2 新卡密前台兑卡校验通过', v2.status === 200 && v2.body.success === true, JSON.stringify(v2.body).slice(0, 200));
        }
    } else ok('F16.x 依赖管理员令牌（跳过）', false, 'no admin token');

    // ── F17 越权 ──
    console.log('F17 · 越权与鉴权');
    const noTok = await j('GET', '/api/tenant/orders', {});
    ok('F17.1 无令牌查订单被拒（401）', noTok.status === 401, 'status=' + noTok.status);
    const badTok = await j('GET', '/api/tenant/wallet', { ct: 'bad.token' });
    ok('F17.2 伪造令牌被拒（401）', badTok.status === 401, 'status=' + badTok.status);

    // ── 清理：删除本套件创建的功能测试商品（避免污染真实货架）──
    try {
        const mysql = require('mysql2/promise');
        const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3310, user: 'root', password: env('DB_PASSWORD', ''), database: env('DB_NAME', 'plus_papay') });
        const [rows] = await conn.query('SELECT id, code FROM kc_plans WHERE display_name=?', [prodName]);
        for (const p of rows) {
            const [o] = await conn.query('SELECT COUNT(*) c FROM kc_api_orders WHERE sku_code=?', [p.code]);
            if (Number(o[0].c) > 0) { console.log('  · 保留测试商品（已有订单）：' + p.code); continue; }
            await conn.query('DELETE FROM kc_listing_cards WHERE plan_id=?', [p.id]);
            await conn.query('DELETE FROM kc_plans WHERE id=?', [p.id]);
            console.log('  · 已清理测试商品 ' + p.code + '（' + prodName + '）');
        }
        await conn.end();
    } catch (e) { console.log('  · 商品清理跳过：' + (e && e.message)); }

    console.log('\n=== 功能回归结果：PASS=' + pass + ' FAIL=' + fail + ' ===');
    if (failures.length) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('\n测试账号: ' + email + ' / ' + PW);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(2); });
