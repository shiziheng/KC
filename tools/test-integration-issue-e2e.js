/**
 * 段 C1 真实端到端验证：直接打运行中的 KC 容器 (localhost:3100)
 *  1) health 应显示 enabled=false（初始未启用）
 *  2) 未启用时 issue 应 403
 *  3) 用数据库直接开启并写密钥
 *  4) 错误密钥 → 401
 *  5) 正确密钥首次 issue → 发新 CDK
 *  6) 同 ref 重复 → 同一张（reused=true）
 *  7) 换 plan_type 重复 → 仍原 CDK
 *  8) GET 回查 ref
 *  9) 落库校验：cdk_codes 中该 CDK 的 type='自助'、plan_type 正确
 * 10) 非法 plan_type → 400；空 ref → 400
 */
const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');

const env = {};
for (const l of fs.readFileSync('D:/tools/KC-PAY-GPT/.env', 'utf8').split(/\r?\n/)) {
  const i = l.indexOf('=');
  if (i > 0 && !l.trim().startsWith('#')) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

function sql(q) {
  try {
    return execFileSync('docker', ['exec', 'kc-gpt-pay2-mysql', 'mysql', '-uroot', '-p' + env.DB_PASSWORD, '--default-character-set=utf8mb4', '-e', q, env.DB_NAME], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { return 'ERR: ' + (e.stderr || e.message); }
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      host: '127.0.0.1', port: 3100, method, path,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        headers
      )
    };
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch (_) { parsed = d.slice(0, 200); }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    if (payload) r.write(payload);
    r.end();
  });
}

const R = [];
const ok = (n, c, x = '') => R.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '   | ' + x : ''}`);

(async () => {
  // 等容器就绪
  let ready = null;
  for (let i = 0; i < 30; i += 1) {
    ready = await req('GET', '/api/public/runtime');
    if (ready.status === 200) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  ok('0 容器探活 /api/public/runtime', ready && ready.status === 200, `status=${ready && ready.status}`);

  // 1 初始 health
  sql("INSERT INTO app_config (config_key, config_value) VALUES ('integration_enabled','0') ON DUPLICATE KEY UPDATE config_value='0';");
  let h = await req('GET', '/api/integration/health');
  ok('1 health 可访问', h.status === 200 && h.body && h.body.success === true,
    JSON.stringify(h.body && h.body.data));
  ok('1b 初始 enabled=false', h.body && h.body.data && h.body.data.enabled === false,
    JSON.stringify(h.body && h.body.data));

  // 2 未启用时 issue 应 403
  let r403 = await req('POST', '/api/integration/cdk/issue', { ref: 'XB-TEST-DISABLED', plan_type: 'plus' }, { 'X-Integration-Key': 'whatever' });
  ok('2 未启用时 issue → 403', r403.status === 403, `status=${r403.status}`);

  // 3 开启 + 写密钥
  sql("INSERT INTO app_config (config_key, config_value) VALUES ('integration_enabled','1') ON DUPLICATE KEY UPDATE config_value='1';");
  sql("INSERT INTO app_config (config_key, config_value) VALUES ('integration_key','ik_test_suite_key_0001') ON DUPLICATE KEY UPDATE config_value='ik_test_suite_key_0001';");
  h = await req('GET', '/api/integration/health');
  ok('3 开启后 health.enabled=true', h.body && h.body.data && h.body.data.enabled === true,
    JSON.stringify(h.body && h.body.data));

  // 4 错误密钥 → 401
  let bad = await req('POST', '/api/integration/cdk/issue', { ref: 'XB-TEST-001', plan_type: 'plus' }, { 'X-Integration-Key': 'wrong_key' });
  ok('4 错误密钥 → 401', bad.status === 401, `status=${bad.status}`);

  // 5 首次发放
  const REF = 'XB-TEST-001';
  sql(`DELETE FROM integration_cdk_issue WHERE ref='${REF}';`);
  let first = await req('POST', '/api/integration/cdk/issue', { ref: REF, plan_type: 'plus', source: 'xboard', order_id: 123 }, { 'X-Integration-Key': 'ik_test_suite_key_0001' });
  console.log('[debug] first resp =', JSON.stringify(first));
  const cdk1 = first.body && first.body.data && first.body.data.cdk;
  ok('5 首次发放返回新 CDK', first.status === 200 && /^KC-[A-Z0-9]{15}$/.test(cdk1 || '') && first.body.data.reused === false,
    `status=${first.status} cdk=${cdk1}`);

  // 6 重复发放
  let second = await req('POST', '/api/integration/cdk/issue', { ref: REF, plan_type: 'plus' }, { 'X-Integration-Key': 'ik_test_suite_key_0001' });
  console.log('[debug] second resp =', JSON.stringify(second));
  const cdk2 = second.body && second.body.data && second.body.data.cdk;
  ok('6 同 ref 重复 → 同一张', cdk2 === cdk1 && second.body && second.body.data && second.body.data.reused === true, `cdk=${cdk2} body=${JSON.stringify(second.body)}`);

  // 7 换套餐重放
  let third = await req('POST', '/api/integration/cdk/issue', { ref: REF, plan_type: 'pro_20x' }, { 'X-Integration-Key': 'ik_test_suite_key_0001' });
  const cdk3 = third.body && third.body.data && third.body.data.cdk;
  ok('7 换套餐重放仍返回原 CDK', cdk3 === cdk1, `cdk=${cdk3} body=${JSON.stringify(third.body)}`);

  // 8 GET 回查
  let get1 = await req('GET', `/api/integration/cdk/issue?ref=${REF}`, null, { 'X-Integration-Key': 'ik_test_suite_key_0001' });
  ok('8 GET 回查 ref 成功', get1.status === 200 && get1.body && get1.body.data && get1.body.data.cdk === cdk1, JSON.stringify(get1.body));

  // 9 落库校验 type='自助'
  const row = cdk1
    ? sql(`SELECT cdk_code, type, plan_type, is_active, used_at FROM cdk_codes WHERE cdk_code='${cdk1}';`)
    : '(无 cdk1，跳过)';
  const isSelf = /自助/.test(row);
  const isPlus = /plus/.test(row);
  ok('9 落库 type=自助 且 plan_type=plus', isSelf && isPlus, row.replace(/\s+/g, ' ').trim());

  // 10 非法 plan_type
  let badPlan = await req('POST', '/api/integration/cdk/issue', { ref: 'XB-BAD-PLAN', plan_type: 'nope' }, { 'X-Integration-Key': 'ik_test_suite_key_0001' });
  ok('10 非法 plan_type → 400', badPlan.status === 400, `status=${badPlan.status} msg=${badPlan.body && badPlan.body.message}`);

  // 11 空 ref
  let noRef = await req('POST', '/api/integration/cdk/issue', { plan_type: 'plus' }, { 'X-Integration-Key': 'ik_test_suite_key_0001' });
  ok('11 空 ref → 400', noRef.status === 400, `status=${noRef.status}`);

  // 12 三个档位都能发
  const plans = ['plus', 'pro_5x', 'pro_20x'];
  let allOk = true; const detail = [];
  for (const p of plans) {
    const ref2 = `XB-PLAN-${p}`;
    sql(`DELETE FROM integration_cdk_issue WHERE ref='${ref2}';`);
    const rr = await req('POST', '/api/integration/cdk/issue', { ref: ref2, plan_type: p }, { 'X-Integration-Key': 'ik_test_suite_key_0001' });
    const c = rr.body && rr.body.data && rr.body.data.cdk;
    const dbRow = sql(`SELECT plan_type FROM cdk_codes WHERE cdk_code='${c}';`);
    const match = dbRow.includes(p);
    if (!match) allOk = false;
    detail.push(`${p}:${c}:${match ? 'ok' : 'MISMATCH'}`);
  }
  ok('12 三个档位 plan_type 均正确落库', allOk, detail.join(' '));

  // 13 并发 5 次同 ref（真实并发）
  const RACE_REF = 'XB-RACE-001';
  sql(`DELETE FROM integration_cdk_issue WHERE ref='${RACE_REF}';`);
  const races = await Promise.all(Array.from({ length: 5 }, () =>
    req('POST', '/api/integration/cdk/issue', { ref: RACE_REF, plan_type: 'plus' }, { 'X-Integration-Key': 'ik_test_suite_key_0001' })
  ));
  const uniqueCdks = new Set(races.map((x) => x.body && x.body.data && x.body.data.cdk).filter(Boolean));
  const allOkStatus = races.every((x) => x.status === 200);
  ok('13 真实并发 5 次只发 1 张', uniqueCdks.size === 1 && allOkStatus,
    `unique=${uniqueCdks.size} statuses=${races.map((x) => x.status).join(',')}`);

  // 汇总
  const text = R.join('\n');
  fs.writeFileSync('D:/tools/KC-PAY-GPT/.workbuddy/c1-e2e-result.txt', text, 'utf8');
  console.log(text);
  const pass = R.filter((x) => x.startsWith('PASS')).length;
  console.log(`\n合计: ${pass}/${R.length}`);
  process.exit(pass === R.length ? 0 : 1);
})();
