#!/usr/bin/env node
/**
 * tools/check-docs-sync.js
 * ------------------------------------------------------------------
 * 检查「代码/版本」与「产品文档」是否同步 —— 防止改了功能却忘了更新产品全景。
 *
 * 用法：
 *   node tools/check-docs-sync.js          # 人读输出（适合双击）
 *   node tools/check-docs-sync.js --json   # 机器可读输出（适合接 CI / 钩子）
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL 项（应阻止提交）
 *
 * 检查项：
 *   1. VERSION.json / CHANGELOG 顶部 / README 三处版本号必须一致
 *   2. 产品全景的「对应版本」不能落后于当前版本（落后 = 功能变了没同步全景）
 *   3. 产品全景必须存在核心章节，且必须有「明确不做什么」防止功能被误加回来
 *   4. 开发规范必须保留「同步产品全景」这一步，且步骤编号连续
 *   5. CHANGELOG 每个版本条目必须含「验证」与「下一步」
 *   6. 关键文件不得出现编码损坏（U+FFFD）
 *   7. 入口文件必须引用产品全景（否则模型找不到）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = (...s) => path.join(ROOT, ...s);
const useJson = process.argv.includes('--json');

const results = [];
const ok = (name, detail) => results.push({ level: 'PASS', name, detail: detail || '' });
const warn = (name, detail) => results.push({ level: 'WARN', name, detail: detail || '' });
const fail = (name, detail) => results.push({ level: 'FAIL', name, detail: detail || '' });

function read(rel) {
  try { return fs.readFileSync(P(rel), 'utf8'); }
  catch { return null; }
}

// ---------- 版本号工具：支持 v1.6.1 与 1.6.1 ----------
function parseVer(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s || '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// ================= 1. 三处版本号一致 =================
let version = null;
const vjRaw = read('VERSION.json');
if (!vjRaw) {
  fail('VERSION.json 存在', '文件缺失');
} else {
  let vj = null;
  try { vj = JSON.parse(vjRaw); } catch (e) { fail('VERSION.json 合法', e.message); }
  if (vj) {
    ok('VERSION.json 合法', vj.version_tag);
    version = parseVer(vj.version_tag);
    if (!version) fail('VERSION.json 版本号格式', '不是 vX.Y.Z 形式: ' + vj.version_tag);
  }
}

const cl = read('CHANGELOG.md') || '';
const rd = read('README.md') || '';
const dev = read('docs/开发规范.md') || '';
const status = read('docs/00_项目状态.md') || '';
const pan = read('docs/产品全景.md');

const clTopRaw = (cl.match(/^## (v\d+\.\d+\.\d+)/m) || [])[1];
const clTop = parseVer(clTopRaw);
const rdRaw = (rd.match(/\*\*`(v\d+\.\d+\.\d+)`/) || [])[1];
const rdVer = parseVer(rdRaw);

if (!clTop) fail('CHANGELOG 顶部有版本条目', '未找到 "## vX.Y.Z" 开头的条目');
else ok('CHANGELOG 顶部版本', clTopRaw);

if (!rdVer) fail('README 顶部有当前版本', '未找到 **`vX.Y.Z`** 形式标注');
else ok('README 当前版本', rdRaw);

if (version && clTop && cmpVer(version, clTop) !== 0)
  fail('版本号一致（VERSION.json vs CHANGELOG）', `${version.join('.')} vs ${clTop.join('.')}`);
if (version && rdVer && cmpVer(version, rdVer) !== 0)
  fail('版本号一致（VERSION.json vs README）', `${version.join('.')} vs ${rdVer.join('.')}`);
if (version && clTop && rdVer && cmpVer(version, clTop) === 0 && cmpVer(version, rdVer) === 0)
  ok('三处版本号一致', clTopRaw);

// ================= 2. 产品全景版本不能落后 =================
if (!pan) {
  fail('docs/产品全景.md 存在', '文件缺失 —— 产品能力无正本，模型将无法判断系统现状');
} else {
  ok('docs/产品全景.md 存在', `${pan.split('\n').length} 行`);
  const panRaw = (pan.match(/\*\*对应版本\*\*：`v\d+\.\d+\.\d+`/) || [])[0];
  const panVer = parseVer((pan.match(/\*\*对应版本\*\*：`v(\d+\.\d+\.\d+)`/) || [])[1]);
  if (!panVer) {
    fail('产品全景标注了对应版本', '缺少 "**对应版本**：`vX.Y.Z`"，无法检测滞后');
  } else if (clTop && cmpVer(panVer, clTop) < 0) {
    fail('产品全景未落后于当前版本',
      `全景停留在 v${panVer.join('.')}，当前已 v${clTop.join('.')} —— ` +
      `新增功能很可能未同步（按规范第 ③ 步补全）`);
  } else {
    ok('产品全景未落后于当前版本', `v${panVer.join('.')}`);
  }
}

// ================= 3. 产品全景核心章节完整 =================
if (pan) {
  const must = [
    ['一、这个系统是做什么的', '系统定位'],
    ['二、系统怎么向用户卖东西', '业务流程'],
    ['三、现在有哪些功能', '功能清单'],
    ['四、明确不做什么', '防误加回的功能边界'],
    ['五、未来规划', '未来规划三档'],
    ['六、不可跨越的红线', '红线'],
  ];
  const missing = must.filter(([needle]) => !pan.includes(needle)).map(([, label]) => label);
  if (missing.length) fail('产品全景核心章节完整', `缺少: ${missing.join('、')}`);
  else ok('产品全景核心章节完整', `${must.length} 个必需章节齐备`);

  // 三档规划必须分开，避免把远期想法误读成马上要做
  const tiers = ['第一档：已确认要做', '第二档：明确不做', '第三档：远期规划'];
  const missTier = tiers.filter(t => !pan.includes(t));
  if (missTier.length) fail('未来规划三档分开', `缺少档位: ${missTier.join('、')}`);
  else ok('未来规划三档分开', '待做 / 不做 / 远期 各归其位');

  // 关键红线必须在位（防止被后续迭代删掉）
  const redlines = ['代充永远走模拟', '用户授权信息不保存', '真实支付保持关闭', 'KC 后台菜单不动', '钱必须走流水'];
  const missRl = redlines.filter(r => !pan.includes(r));
  if (missRl.length) fail('产品红线未被删减', `缺失: ${missRl.join('、')}`);
  else ok('产品红线未被删减', `${redlines.length} 条红线在位`);
}

// ================= 4. 开发规范保留「同步产品全景」 =================
{
  const hasStep = /同步产品全景（涉及功能时必做）/.test(dev);
  hasStep ? ok('开发规范含「同步产品全景」步骤') : fail('开发规范含「同步产品全景」步骤', '该步骤被删除，防脱节机制失效');

  const steps = (dev.match(/^### [①②③④⑤⑥⑦] /gm) || []).map(s => s[4]);
  const uniq = [...new Set(steps)];
  if (steps.length === 6 && uniq.length === 6) ok('开发规范流程步骤连续', steps.join(''));
  else warn('开发规范流程步骤连续', `实际 ${steps.length} 步: ${steps.join('') || '未找到'}`);

  const inChecklist = /产品全景\.md` 已同步|同步产品全景/.test(dev);
  inChecklist ? ok('开发规范自检清单含全景检查') : warn('开发规范自检清单含全景检查', '建议在第 8 节自检清单加入全景同步项');
}

// ================= 5. CHANGELOG 条目含验证与下一步 =================
{
  const blocks = cl.split(/^## v/m).slice(1);
  if (!blocks.length) fail('CHANGELOG 有版本条目', '未找到任何条目');
  else {
    const bad = [];
    blocks.forEach((b, i) => {
      const v = (b.match(/^([\d.]+)/) || [])[1] || `#${i + 1}`;
      if (!/### 验证/.test(b)) bad.push(`${v} 缺「验证」`);
      if (!/### 下一步/.test(b)) bad.push(`${v} 缺「下一步」`);
    });
    if (bad.length) fail('每个版本含验证与下一步', bad.slice(0, 5).join('；'));
    else ok('每个版本含验证与下一步', `${blocks.length} 个条目齐备`);
  }
}

// ================= 6. 编码损坏 =================
{
  const files = ['README.md', 'CHANGELOG.md', 'docs/产品全景.md', 'docs/开发规范.md', 'docs/00_项目状态.md', 'VERSION.json'];
  const broken = files.filter(f => { const c = read(f); return c && c.includes('\uFFFD'); });
  broken.length ? fail('关键文件编码正常', `含乱码字符 U+FFFD: ${broken.join('、')}`)
               : ok('关键文件编码正常', `${files.length} 个文件无乱码`);
}

// ================= 7. 入口文件引用产品全景 =================
{
  const refs = [['README.md', rd], ['docs/开发规范.md', dev], ['docs/00_项目状态.md', status]];
  const missing = refs.filter(([, c]) => c && !c.includes('产品全景.md')).map(([f]) => f);
  missing.length ? fail('入口文件引用产品全景', `未引用: ${missing.join('、')}（模型将找不到产品正本）`)
                 : ok('入口文件引用产品全景', `${refs.length} 个入口均已引用`);
}

// ================= 输出 =================
const p = results.filter(r => r.level === 'PASS').length;
const w = results.filter(r => r.level === 'WARN').length;
const f = results.filter(r => r.level === 'FAIL').length;

if (useJson) {
  console.log(JSON.stringify({
    pass: p, warn: w, fail: f,
    version: version ? version.join('.') : null,
    results,
  }, null, 2));
} else {
  const icon = { PASS: '[OK]', WARN: '[!]', FAIL: '[X]' };
  const color = { PASS: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m' };
  const reset = '\x1b[0m';
  console.log('');
  console.log('=== 文档同步自检 (check-docs-sync) ===');
  console.log('');
  for (const r of results) {
    console.log(`  ${color[r.level]}${icon[r.level]}${reset} ${r.name}${r.detail ? `\n       ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`  通过 ${p} · 警告 ${w} · 失败 ${f}`);
  console.log('');
  if (f > 0) {
    console.log('  \x1b[31m文档与代码未同步 —— 请先补全再提交。\x1b[0m');
    console.log('  补全顺序：产品全景.md → CHANGELOG.md → README.md / 00_项目状态.md → VERSION.json');
    console.log('  详见 docs/开发规范.md 第 2 节六步流程。');
  } else {
    console.log('  \x1b[32m文档与代码同步，无需补全。\x1b[0m');
  }
}

process.exit(f > 0 ? 1 : 0);