// ⚠️ 已退役（v2.1.0 · Xboard 代码摘除）：本文件属 Xboard 时代工具链，仅作历史/回滚参考，日常开发与部署不再使用。
/**
 * 段 C1 幂等发放逻辑 — 离线模型自测
 *
 * 因为本机没装 mysql2（它在容器内），无法直接 require mysql-store.js。
 * 这里把 issueCdkByRef 的分支逻辑逐条等价重放，验证：
 *   1) 首次发放 → 新 CDK
 *   2) 同 ref 重复 → 同一张（reused）
 *   3) 换套餐重放 → 仍返回原 CDK（幂等优先）
 *   4) 并发抢占 → 后到者拿到先到者结果
 *   5) 生成失败 → 释放占位、可重试
 *   6) 不同 ref 互不干扰
 *   7) UNIQUE(ref) 约束成立
 */

const T = { issue: [], cdk: [] };
let counter = 0;

function reset() { T.issue.length = 0; T.cdk.length = 0; counter = 0; }

function runExecute(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (/INSERT INTO integration_cdk_issue \(ref, source, cdk_code, plan_type, order_id, user_ref\)/i.test(s)) {
    const [ref, source, planType, orderId, userRef] = params;
    if (T.issue.some((r) => r.ref === ref)) return { affectedRows: 0 };
    T.issue.push({ ref, source, cdk_code: '', plan_type: planType, order_id: orderId, user_ref: userRef });
    return { affectedRows: 1 };
  }
  if (/UPDATE integration_cdk_issue SET cdk_code = \?, plan_type = \? WHERE ref = \?/i.test(s)) {
    const [cdk, planType, ref] = params;
    const row = T.issue.find((r) => r.ref === ref);
    if (!row) return { affectedRows: 0 };
    row.cdk_code = cdk; row.plan_type = planType;
    return { affectedRows: 1 };
  }
  if (/DELETE FROM integration_cdk_issue WHERE ref = \? AND cdk_code = ''/i.test(s)) {
    const i = T.issue.findIndex((r) => r.ref === params[0] && r.cdk_code === '');
    if (i >= 0) { T.issue.splice(i, 1); return { affectedRows: 1 }; }
    return { affectedRows: 0 };
  }
  return { affectedRows: 0 };
}

function runQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/FROM integration_cdk_issue WHERE ref = \?/i.test(s)) {
    const row = T.issue.find((r) => r.ref === params[0]);
    return row ? [{ ...row }] : [];
  }
  return [];
}

const VALID_PLAN_TYPES = new Set(['plus', 'pro_5x', 'pro_20x']);

// ── 与源码 issueCdkByRef 分支一一对应 ──
async function issueCdkByRef(ref, options = {}) {
  const normalizedRef = String(ref || '').trim();
  if (!normalizedRef) throw new Error('ref 不能为空');
  if (normalizedRef.length > 64) throw new Error('ref 长度不能超过 64');

  const planType = VALID_PLAN_TYPES.has(options.planType) ? options.planType : 'plus';
  const cdkFactory = typeof options.createCdks === 'function' ? options.createCdks : null;

  const existingRows = runQuery(
    'SELECT ref, source, cdk_code, plan_type FROM integration_cdk_issue WHERE ref = ? LIMIT 1',
    [normalizedRef]
  );
  if (existingRows.length > 0 && existingRows[0].cdk_code) {
    return { cdk: existingRows[0].cdk_code, planType: existingRows[0].plan_type, ref: normalizedRef, reused: true };
  }

  if (!cdkFactory) throw new Error('缺少 CDK 生成器');

  const claimed = runExecute(
    'INSERT INTO integration_cdk_issue (ref, source, cdk_code, plan_type, order_id, user_ref) VALUES (?, ?, ?, ?, ?, ?)',
    [normalizedRef, 'xboard', '', planType, null, '']
  );

  if (Number(claimed?.affectedRows || 0) === 0) {
    const rows = runQuery('SELECT ref, source, cdk_code, plan_type FROM integration_cdk_issue WHERE ref = ? LIMIT 1', [normalizedRef]);
    if (rows.length === 0 || !rows[0].cdk_code) throw new Error('幂等键已被占用，但未查到对应 CDK，请稍后重试');
    return { cdk: rows[0].cdk_code, planType: rows[0].plan_type, ref: normalizedRef, reused: true };
  }

  try {
    let newCdk = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (options.simulateInsertFail) break;
      const generated = cdkFactory(1);
      newCdk = Array.isArray(generated) ? generated[0] : generated;
      break;
    }
    if (!newCdk) throw new Error('CDK 生成失败，请重试');
    runExecute('UPDATE integration_cdk_issue SET cdk_code = ?, plan_type = ? WHERE ref = ?', [newCdk, planType, normalizedRef]);
    return { cdk: newCdk, planType, ref: normalizedRef, reused: false };
  } catch (error) {
    runExecute("DELETE FROM integration_cdk_issue WHERE ref = ? AND cdk_code = ''", [normalizedRef]);
    throw error;
  }
}

const factory = () => [`KC-TEST${String(++counter).padStart(11, '0')}`];

// ── 断言 ──
const R = [];
const ok = (name, cond, extra = '') => R.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '   | ' + extra : ''}`);

(async () => {
  reset();
  const a = await issueCdkByRef('XB-ORDER-001', { planType: 'plus', createCdks: factory });
  ok('1 首次发放返回新 CDK', a.cdk === 'KC-TEST00000000001' && a.reused === false, a.cdk);

  const b = await issueCdkByRef('XB-ORDER-001', { planType: 'plus', createCdks: factory });
  ok('2 重复调用返回同一 CDK', b.cdk === a.cdk && b.reused === true, b.cdk);

  const c = await issueCdkByRef('XB-ORDER-001', { planType: 'pro_20x', createCdks: factory });
  ok('3 换套餐重放仍返回原 CDK', c.cdk === a.cdk && c.reused === true, c.cdk);

  ok('4 三次调用只消耗 1 个 CDK', counter === 1, 'counter=' + counter);

  // 并发抢占
  reset();
  runExecute('INSERT INTO integration_cdk_issue (ref, source, cdk_code, plan_type, order_id, user_ref) VALUES (?, ?, ?, ?, ?, ?)', ['XB-C', 'xboard', '', 'plus', null, '']);
  runExecute('UPDATE integration_cdk_issue SET cdk_code = ?, plan_type = ? WHERE ref = ?', ['KC-WINNER0000000', 'plus', 'XB-C']);
  const d = await issueCdkByRef('XB-C', { planType: 'plus', createCdks: factory });
  ok('5 并发下后到者拿到先到者 CDK', d.cdk === 'KC-WINNER0000000' && d.reused === true, d.cdk);

  // 失败释放
  reset();
  let threw = false;
  try { await issueCdkByRef('XB-F', { planType: 'plus', createCdks: () => [], simulateInsertFail: true }); }
  catch (e) { threw = true; }
  ok('6 生成失败抛错', threw);
  ok('7 失败后占位已释放', T.issue.length === 0, 'issue=' + T.issue.length);

  const e2 = await issueCdkByRef('XB-F', { planType: 'plus', createCdks: factory });
  ok('8 失败后可重试成功', e2.reused === false && e2.cdk === 'KC-TEST00000000001', e2.cdk);

  // 隔离
  const f = await issueCdkByRef('XB-OTHER', { planType: 'pro_5x', createCdks: factory });
  ok('9 不同 ref 互不干扰', f.cdk !== e2.cdk && f.planType === 'pro_5x', f.cdk + '/' + f.planType);

  // 约束
  const refs = T.issue.map((r) => r.ref);
  ok('10 ref 无重复（UNIQUE 约束成立）', new Set(refs).size === refs.length, refs.join(','));

  // 非法 plan_type
  const g = await issueCdkByRef('XB-BAD', { planType: 'not_a_plan', createCdks: factory });
  ok('11 非法 plan_type 回退 plus', g.planType === 'plus', g.planType);

  // 空 ref
  let emptyThrew = false;
  try { await issueCdkByRef('', { createCdks: factory }); } catch (e) { emptyThrew = true; }
  ok('12 空 ref 抛错', emptyThrew);

  // 超长 ref
  let longThrew = false;
  try { await issueCdkByRef('x'.repeat(65), { createCdks: factory }); } catch (e) { longThrew = true; }
  ok('13 超长 ref 抛错', longThrew);

  const text = R.join('\n');
  require('fs').writeFileSync(__dirname + '/c1-selftest-result.txt', text, 'utf8');
  console.log(text);
  const pass = R.filter((x) => x.startsWith('PASS')).length;
  console.log(`\n合计: ${pass}/${R.length}`);
  process.exit(pass === R.length ? 0 : 1);
})();
