/**
 * 真并发竞争测试：用 net 层同时建立 5 个连接，尽量在同一 tick 发出请求。
 * 同时直接查库确认最终只落 1 条 issue 记录 + 1 张 CDK。
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

function once(ref) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ ref, plan_type: 'plus' });
    const r = http.request({
      host: '127.0.0.1', port: 3100, method: 'POST', path: '/api/integration/cdk/issue',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Integration-Key': 'ik_test_suite_key_0001'
      }
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let b = null; try { b = JSON.parse(d); } catch (_) { b = d.slice(0, 120); }
        resolve({ status: res.statusCode, body: b });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.write(payload);
    r.end();
  });
}

(async () => {
  const REF = 'XB-RACE-STRICT';
  sql(`DELETE FROM integration_cdk_issue WHERE ref='${REF}';`);

  const N = 8;
  const res = await Promise.all(Array.from({ length: N }, () => once(REF)));

  const codes = res.map((x) => (x.body && x.body.data && x.body.data.cdk) || null);
  const uniq = new Set(codes.filter(Boolean));
  const statuses = res.map((x) => x.status);

  const issueRows = sql(`SELECT COUNT(*) AS c FROM integration_cdk_issue WHERE ref='${REF}';`)
    .replace(/\s+/g, ' ').trim();
  const issuedCdk = sql(`SELECT cdk_code FROM integration_cdk_issue WHERE ref='${REF}';`)
    .replace(/\s+/g, ' ').trim();

  const out = [];
  out.push(`并发数: ${N}`);
  out.push(`HTTP 状态: ${statuses.join(', ')}`);
  out.push(`返回的不同 CDK 数: ${uniq.size}`);
  out.push(`返回的 CDK: ${codes.map((c) => c || '(null)').join(', ')}`);
  out.push(`最终 issue 表行数: ${issueRows}`);
  out.push(`最终 issue 表 cdk_code: ${issuedCdk}`);
  out.push('');
  out.push(uniq.size === 1 ? 'PASS  真并发下只产生 1 张 CDK' : `FAIL  真并发下产生了 ${uniq.size} 张 CDK`);

  // 孤儿 CDK 检查：该次并发期间新产生的 CDK 应恰好 1 张（即最终 issue 记录里那张）
  const finalCdk = issuedCdk.split(/\s+/).pop();
  const extra = sql(`SELECT cdk_code FROM cdk_codes WHERE cdk_code LIKE 'KC-%' AND created_at >= NOW() - INTERVAL 60 SECOND ORDER BY id DESC;`)
    .replace(/\s+/g, ' ').trim();
  out.push('');
  out.push(`近 60 秒新增 CDK: ${extra}`);

  fs.writeFileSync('D:/tools/KC-PAY-GPT/.workbuddy/race-result.txt', out.join('\n'), 'utf8');
  console.log(out.join('\n'));
})();
