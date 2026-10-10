// tools/test-topup-panel-flow.js — 充值面板全链路体检（复刻面板调用，不付款）
//   注册 → prepare($1) → 原生 order/save → getPaymentMethod → checkout → 探收银台
//
// 用途：Xboard 容器重建后 / 充值链路异常时核查（尤其是补丁 1「kc_is_topup 豁免」是否在位）。
// 运行：从仓库根执行   node tools/test-topup-panel-flow.js
// 说明：会新建 1 个测试号并产生 1 笔未支付测试单（到期自动过期），不涉及真实资金。
//       结果落盘 _topup_panel_flow.txt（仓库根，已被 .gitignore 忽略）。
const fs = require('fs');
const path = require('path');
const http = require('http');

const OUT = path.join(process.cwd(), '_topup_panel_flow.txt');
const L = [];
const log = (...a) => L.push(a.map(String).join(' '));

function req(method, p, body, headers) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, headers || {});
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: 7001, path: p, method, headers: h, timeout: 15000 }, rs => {
      const parts = []; rs.on('data', c => parts.push(c));
      rs.on('end', () => resolve({ s: rs.statusCode, b: Buffer.concat(parts).toString('utf8') }));
    });
    r.on('error', e => resolve({ s: 0, err: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ s: 0, err: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}
function reqGetUrl(u) { // 访问完整 URL（不自动跟随）
  return new Promise(resolve => {
    try {
      const U = new URL(u);
      const r = http.request({ host: U.hostname, port: U.port || 80, path: U.pathname + U.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, rs => {
        const parts = []; rs.on('data', c => parts.push(c));
        rs.on('end', () => resolve({ s: rs.statusCode, loc: rs.headers.location, len: Buffer.concat(parts).length }));
      });
      r.on('error', e => resolve({ s: 0, err: e.message }));
      r.on('timeout', () => { r.destroy(); resolve({ s: 0, err: 'timeout' }); });
      r.end();
    } catch (e) { resolve({ s: 0, err: String(e.message) }); }
  });
}
function json(b) { try { return JSON.parse(b); } catch (e) { return null; } }
function deepFind(o, key) {
  if (o == null || typeof o !== 'object') return undefined;
  if (!Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, key)) return o[key];
  const vals = Array.isArray(o) ? o : Object.values(o);
  for (const v of vals) { const r = deepFind(v, key); if (r !== undefined) return r; }
  return undefined;
}

(async () => {
  const ts = Date.now();
  const email = 'qc-flow-' + ts + '@example.com';
  const password = 'QcTest!' + ts;

  log('=== 0. 注册新测试号 ===');
  log('email = ' + email);
  let r = await req('POST', '/api/v1/passport/auth/register', { email, password });
  log('register -> HTTP ' + r.s);
  let j = json(r.b);
  let authRaw = j && j.data && (j.data.auth_data || (j.data.token ? ('Bearer ' + j.data.token) : null));
  if (!authRaw) {
    r = await req('POST', '/api/v1/passport/auth/login', { email, password });
    log('login -> HTTP ' + r.s + ' | ' + String(r.b || '').slice(0, 200));
    j = json(r.b);
    authRaw = j && j.data && (j.data.auth_data || (j.data.token ? ('Bearer ' + j.data.token) : null));
  }
  if (!authRaw) { log('!!! 无法获得登录态，中止'); fs.writeFileSync(OUT, L.join('\n'), 'utf8'); console.log('WROTE ' + OUT); return; }
  const auth = { 'Authorization': authRaw };
  log('auth 头: ' + authRaw.slice(0, 14) + '…(len=' + authRaw.length + ')');

  log('\n=== 1. prepare($1) — 应 200 ===');
  let p = await req('POST', '/user/kc/topup/prepare', { amount: 100 }, auth);
  log('-> HTTP ' + p.s + ' | ' + String(p.b || '').slice(0, 300));
  j = json(p.b);
  const planId = j && j.data && j.data.plan_id;
  log('plan_id = ' + planId);
  if (!planId) { log('!!! prepare 未返回 plan_id，中止'); fs.writeFileSync(OUT, L.join('\n'), 'utf8'); console.log('WROTE ' + OUT); return; }

  log('\n=== 2. 原生 order/save（面板同构：period=onetime_price）—— 关键步骤 ===');
  p = await req('POST', '/api/v1/user/order/save', { plan_id: planId, period: 'onetime_price' }, auth);
  log('-> HTTP ' + p.s + ' | ' + String(p.b || '').slice(0, 500));
  j = json(p.b);
  let tradeNo = null;
  if (j) { tradeNo = (typeof j.data === 'string') ? j.data : deepFind(j, 'trade_no'); }
  log('trade_no = ' + (tradeNo || '(无)'));
  const saveOk = p.s === 200 && !!tradeNo;
  if (!saveOk) log('VERDICT: save ' + (p.s === 200 ? 'no trade_no' : 'FAIL HTTP ' + p.s));

  if (saveOk) {
    log('\n=== 3. getPaymentMethod ===');
    p = await req('GET', '/api/v1/user/order/getPaymentMethod', null, auth);
    log('-> HTTP ' + p.s + ' | ' + String(p.b || '').slice(0, 300));
    j = json(p.b);
    const list = j && (Array.isArray(j.data) ? j.data : (j.data && j.data.data) || []);
    const methodId = list.length ? list[0].id : null;
    log('method_id = ' + methodId);
    if (methodId != null) {
      log('\n=== 4. checkout ===');
      p = await req('POST', '/api/v1/user/order/checkout', { trade_no: tradeNo, method: methodId }, auth);
      log('-> HTTP ' + p.s + ' | ' + String(p.b || '').slice(0, 400));
      j = json(p.b);
      let url = null;
      if (j) { url = (typeof j.data === 'string') ? j.data : (j.data && (j.data.data || j.data.url)); }
      log('pay_url = ' + (url || '(无)'));
      if (url && /^https?:/.test(url)) {
        log('\n=== 5. 探收银台（不付款）===');
        const v1 = await reqGetUrl(url);
        log('submit url -> HTTP ' + v1.s + (v1.loc ? ' LOC=' + v1.loc : '') + (v1.err ? ' ERR=' + v1.err : ''));
        if (v1.loc) { const v2 = await reqGetUrl(new URL(v1.loc, url).href); log('cashier -> HTTP ' + v2.s + ' len=' + (v2.len || 0) + (v2.err ? ' ERR=' + v2.err : '')); }
      }
    }
  }

  // DB 核对（只读）
  try {
    const envRaw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const env = {}; for (const line of envRaw.split(/\r?\n/)) { const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3310, user: 'root', password: env.DB_PASSWORD || '', ssl: false });
    const [us] = await conn.query('SELECT id FROM `xboard`.`v2_user` WHERE email=?', [email]);
    if (us.length) {
      const [os] = await conn.query('SELECT trade_no, plan_id, period, status, total_amount, created_at FROM `xboard`.`v2_order` WHERE user_id=? ORDER BY id DESC LIMIT 3', [us[0].id]);
      log('\n=== DB 订单核对（user_id=' + us[0].id + '）===');
      for (const o of os) log(JSON.stringify(o));
    }
    await conn.end();
  } catch (e) { log('DB 核对跳过: ' + String(e.message).slice(0, 120)); }

  fs.writeFileSync(OUT, L.join('\n'), 'utf8');
  console.log('WROTE ' + OUT + (saveOk ? ' [SAVE OK]' : ' [SAVE FAIL]'));
})().catch(e => { fs.writeFileSync(OUT, L.join('\n') + '\nFATAL ' + ((e && e.stack) || e), 'utf8'); console.error('FATAL', e && e.message); process.exit(1); });
