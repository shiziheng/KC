#!/usr/bin/env node
/**
 * tools/check-root-hygiene.js
 * ------------------------------------------------------------------
 * 根目录「随手整洁」守护 —— 防止历史产物（一次性脚本 / 大件 / 备份 / 遗留目录）
 * 重新堆回根目录，把接手的人淹掉。归档规则见 archive/README.md。
 *
 * 用法：
 *   node tools/check-root-hygiene.js          # 人读输出
 *   node tools/check-root-hygiene.js --json   # 机器可读
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL 项（应阻止提交）
 *
 * 检查项（v1.37.0 · Stage 0）：
 *   1. 根目录顶层不得有 _* 条目（临时脚本/探测产物应进 archive/）
 *   2. 根目录顶层文件数 ≤ 70
 *   3. .dockerignore 必须排除 archive（Dockerfile 是 COPY . .，漏了会让镜像变大）
 *   4. .gitignore 必须排除 /archive/
 *   5. 关键文件必须仍在根目录（server.js / mysql-store.js / requirements-hcaptcha.txt / Dockerfile / deploy-manifest.json）
 *   6. 归档区必须有说明与移动日志（archive/README.md、archive/_MOVE_LOG.md）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = (...s) => path.join(ROOT, ...s);
const useJson = process.argv.includes('--json');

const results = [];
const ok = (name, detail) => results.push({ level: 'PASS', name, detail: detail || '' });
const fail = (name, detail) => results.push({ level: 'FAIL', name, detail: detail || '' });

const MAX_ROOT_FILES = 70;
const KEEP_IN_ROOT = [
  'server.js',
  'mysql-store.js',
  'requirements-hcaptcha.txt', // Dockerfile 显式 COPY，不能挪
  'Dockerfile',
  'deploy-manifest.json',
  'VERSION.json',
  'CHANGELOG.md',
  'README.md',
];

function read(rel) {
  try { return fs.readFileSync(P(rel), 'utf8'); }
  catch { return null; }
}

// ---------- 1 & 2. 根目录顶层条目统计 ----------
let topEntries = [];
try { topEntries = fs.readdirSync(ROOT, { withFileTypes: true }); } catch (e) { fail('读取根目录', e.message); }

const underscoreEntries = topEntries.filter((e) => e.name.startsWith('_')).map((e) => e.name);
const fileEntries = topEntries.filter((e) => e.isFile()).map((e) => e.name);

if (underscoreEntries.length === 0) {
  ok('根目录无 _* 条目', '0 个');
} else {
  fail('根目录无 _* 条目', `发现 ${underscoreEntries.length} 个：${underscoreEntries.slice(0, 12).join(', ')}${underscoreEntries.length > 12 ? ' …' : ''}（请移入 archive/ 并在 _MOVE_LOG.md 登记）`);
}

if (fileEntries.length <= MAX_ROOT_FILES) {
  ok('根目录顶层文件数 ≤ ' + MAX_ROOT_FILES, '当前 ' + fileEntries.length + ' 个');
} else {
  fail('根目录顶层文件数 ≤ ' + MAX_ROOT_FILES, '当前 ' + fileEntries.length + ' 个，超出 ' + (fileEntries.length - MAX_ROOT_FILES) + ' 个');
}

// ---------- 3. .dockerignore 排除 archive ----------
const dockerignore = read('.dockerignore');
if (dockerignore === null) {
  fail('.dockerignore 存在', '文件缺失');
} else if (/(^|\n)\s*\/?archive\/?\s*(\n|$)/.test(dockerignore.replace(/\r/g, ''))) {
  ok('.dockerignore 排除 archive', '已命中');
} else {
  fail('.dockerignore 排除 archive', '未排除 —— Dockerfile 是 COPY . .，归档目录会进镜像');
}

// ---------- 4. .gitignore 排除 /archive/ ----------
const gitignore = read('.gitignore');
if (gitignore === null) {
  fail('.gitignore 存在', '文件缺失');
} else if (/(^|\n)\s*\/archive\/\s*(\n|$)/.test(gitignore.replace(/\r/g, ''))) {
  ok('.gitignore 排除 /archive/', '已命中');
} else {
  fail('.gitignore 排除 /archive/', '未排除 —— 归档产物会污染 git status');
}

// ---------- 5. 关键文件仍在根目录 ----------
const missing = KEEP_IN_ROOT.filter((f) => !fs.existsSync(P(f)));
if (missing.length === 0) {
  ok('关键文件仍在根目录', KEEP_IN_ROOT.length + ' 个全在');
} else {
  fail('关键文件仍在根目录', '缺失：' + missing.join(', '));
}

// ---------- 6. 归档区可回溯 ----------
for (const f of ['archive/README.md', 'archive/_MOVE_LOG.md']) {
  if (fs.existsSync(P(f))) ok('归档区文件 ' + f, '存在');
  else fail('归档区文件 ' + f, '缺失（接手者无法查到文件去哪了）');
}

// ---------- 输出 ----------
const failed = results.filter((r) => r.level === 'FAIL');
const passed = results.filter((r) => r.level === 'PASS');

if (useJson) {
  process.stdout.write(JSON.stringify({ ok: failed.length === 0, results }, null, 2) + '\n');
} else {
  for (const r of results) {
    const mark = r.level === 'PASS' ? '[PASS]' : '[FAIL]';
    process.stdout.write(`${mark} ${r.name}${r.detail ? ' — ' + r.detail : ''}\n`);
  }
  process.stdout.write(`\n根目录整洁自检：${passed.length} 通过 / ${failed.length} 失败\n`);
}

process.exit(failed.length === 0 ? 0 : 1);
