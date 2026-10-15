#!/usr/bin/env node
/**
 * tools/xboard-patch-check.js — Xboard 容器补丁在位核查（可选 --fix 自动重打）
 *
 * 背景：Xboard 容器内的 6 处内核补丁不进镜像，容器重建后会静默丢失：
 *   P1 PlanService   —— kc_is_topup 豁免 show 校验（丢 → 充值面板下单被拒「已售罄」）
 *   P2 TopupController —— show=0 套餐可复用（插件侧，宿主挂载）
 *   P3 OrderService  —— 充值套餐不产生佣金
 *   P4 CheckCommission —— 返利以「货交付」为前提（丢 → 失败订单照发佣金）
 *   P5/P6 OrderService + V1 OrderController —— 允许多笔未支付/处理中订单并存
 *        （丢 →  resurrect「您有未付款或开通中的订单」拦截，有未付款单的用户无法再下单）
 *
 * 用法：
 *   node tools/xboard-patch-check.js          # 只核查，缺任一即退出码 1
 *   node tools/xboard-patch-check.js --fix    # 缺失则按 tools/xboard-patches/README.md 自动重打
 *
 * 说明：部署引擎（kc-deploy_20261007.ps1 / .sh）在每次注入后会自动调用等价逻辑；
 *       本脚本供开发/CI/人工修复使用。重打全部为覆盖式 + 幂等，不会重复改代码。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCKER_CANDIDATES = [
  process.env.DOCKER_BIN,
  'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
  'docker',
].filter(Boolean);
const DOCKER = DOCKER_CANDIDATES.find((p) => p === 'docker' || fs.existsSync(p)) || 'docker';

const CHECKS = [
  { name: 'P1 PlanService（kc_is_topup 豁免）', file: '/www/app/Services/PlanService.php', pattern: 'kc_is_topup', min: 1 },
  { name: 'P1b PlanService（权益包豁免）', file: '/www/app/Services/PlanService.php', pattern: 'kc_entitlement_pack', min: 1 },
  { name: 'P3 OrderService（充值不返佣）', file: '/www/app/Services/OrderService.php', pattern: 'kc_is_topup', min: 2 },
  { name: 'P7 OrderService（权益包短路开通）', file: '/www/app/Services/OrderService.php', pattern: 'ENTITLEMENT-PACK', min: 1 },
  { name: 'P8 OrderService（代充按用户权益价结算）', file: '/www/app/Services/OrderService.php', pattern: 'ENTITLEMENT-PRICE', min: 2 },
  { name: 'P4 CheckCommission（交付才结算）', file: '/www/app/Console/Commands/CheckCommission.php', pattern: 'kcHasCardTable', min: 2 },
  { name: 'P2 TopupController（show=0 复用）', file: '/www/plugins/KcIntegration/Controllers/TopupController.php', pattern: 'KC-PATCH2', min: 2 },
  { name: 'P5 OrderService（允许多笔未支付单）', file: '/www/app/Services/OrderService.php', pattern: 'ALLOW-CONCURRENT-ORDERS', min: 1 },
  { name: 'P6 V1 OrderController（允许多笔未支付单）', file: '/www/app/Http/Controllers/V1/User/OrderController.php', pattern: 'ALLOW-CONCURRENT-ORDERS', min: 1 },
];

const FIX_SOURCES = [
  path.join(ROOT, 'tools/xboard-patch-planservice.php'),
  path.join(ROOT, 'tools/xboard-patch-topup-ctrl.php'),
  path.join(ROOT, 'tools/xboard-patches/OrderService.php'),
  path.join(ROOT, 'tools/xboard-patches/CheckCommission.php'),
  path.join(ROOT, 'tools/xboard-patch-allow-concurrent-orders.php'),
  path.join(ROOT, 'tools/xboard-patch-planservice-pack.php'),
];

const FIX_STEPS = [
  { desc: 'P1 重打', cmds: [
    ['cp', FIX_SOURCES[0], 'xboard:/www/xboard-patch.php'],
    ['exec', 'xboard', 'php', '/www/xboard-patch.php'],
  ] },
  { desc: 'P1b 重打（权益包豁免）', cmds: [
    ['cp', FIX_SOURCES[5], 'xboard:/www/xboard-patch-pack.php'],
    ['exec', 'xboard', 'php', '/www/xboard-patch-pack.php'],
  ] },
  { desc: 'P2 重打', cmds: [
    ['cp', FIX_SOURCES[1], 'xboard:/www/xboard-patch2.php'],
    ['exec', 'xboard', 'php', '/www/xboard-patch2.php'],
  ] },
  { desc: 'P3 重打', cmds: [
    ['cp', FIX_SOURCES[2], 'xboard:/www/app/Services/OrderService.php'],
  ] },
  // ⚠️ 顺序要点：P3 是整文件覆盖 OrderService.php，会冲掉 P5 的补丁，
  //    所以 P5/P6 必须排在 P3 之后重打（脚本幂等，重复执行不会重复改）。
  { desc: 'P5/P6 重打（允许多笔未支付单）', cmds: [
    ['cp', FIX_SOURCES[4], 'xboard:/www/xboard-patch-allow-concurrent-orders.php'],
    ['exec', 'xboard', 'php', '/www/xboard-patch-allow-concurrent-orders.php'],
  ] },
  { desc: 'P4 重打', cmds: [
    ['cp', FIX_SOURCES[3], 'xboard:/www/app/Console/Commands/CheckCommission.php'],
  ] },
  { desc: '重载 Octane', cmds: [
    ['exec', 'xboard', 'php', 'artisan', 'octane:reload'],
  ] },
];

function docker(args, quiet = true) {
  return execFileSync(DOCKER, args, {
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  }).toString();
}

function count(check) {
  try {
    const out = docker(['exec', 'xboard', 'sh', '-c', `grep -c ${check.pattern} ${check.file}`]);
    const m = out.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  } catch (e) {
    return 0;
  }
}

function runCheck(verbose) {
  let allOk = true;
  for (const c of CHECKS) {
    const n = count(c);
    const ok = n >= c.min;
    if (!ok) allOk = false;
    if (verbose) console.log(`${ok ? '  [OK]  ' : '  [MISS]'} ${c.name}: ${n}/${c.min}`);
  }
  return allOk;
}

(function main() {
  const wantFix = process.argv.includes('--fix');
  console.log('== Xboard 补丁核查 ==');
  let running = '';
  try {
    running = docker(['ps', '--filter', 'name=^xboard$', '--format', '{{.Names}}']).trim();
  } catch (e) {
    console.error('无法执行 docker（' + DOCKER + '）：' + e.message);
    process.exit(2);
  }
  if (!running) {
    console.error('xboard 容器未运行，无法核查。');
    process.exit(2);
  }

  const ok = runCheck(true);
  if (ok) {
    console.log('VERDICT: 全部补丁在位 ✓');
    process.exit(0);
  }
  if (!wantFix) {
    console.log('VERDICT: 有补丁缺失 —— 重跑加 --fix 自动重打，或按 tools/xboard-patches/README.md 手工处理。');
    process.exit(1);
  }

  console.log('-- 缺失，开始自动重打 --');
  for (const s of FIX_SOURCES) {
    if (!fs.existsSync(s)) {
      console.error('缺补丁源文件: ' + s + '（无法自动重打，请检查仓库）');
      process.exit(1);
    }
  }
  for (const step of FIX_STEPS) {
    console.log('-> ' + step.desc);
    try {
      for (const cmd of step.cmds) docker(cmd, false);
    } catch (e) {
      console.error('   步骤失败: ' + e.message);
    }
  }

  const okAfter = runCheck(true);
  if (okAfter) {
    console.log('VERDICT: 重打完成，全部补丁在位 ✓');
    process.exit(0);
  }
  console.error('VERDICT: 重打后仍有缺失，请人工按 tools/xboard-patches/README.md 处理。');
  process.exit(1);
})();
