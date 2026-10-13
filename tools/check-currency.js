#!/usr/bin/env node
/**
 * tools/check-currency.js — 全站货币显示守护（2026-10-11 · 用户要求）
 *
 * 规则：系统内所有面向用户/运营的金额与余额一律以**美元（$）**展示，
 *       不允许出现 人民币符号（¥/￥）或 人民币字样（CNY/RMB/人民币）。
 *
 * 覆盖范围（显示面）：
 *   - 前端注入三源（tools/kc_*.html）
 *   - KC 公开页面 public/*.html、server.js
 *   - Xboard 插件快照 tools/xboard-patches/**（与运行实例对齐）
 *   - 部署引擎脚本
 *
 * 白名单（均为「货币兜底替换实现」自身，必须包含 ¥ 字面量才能做运行时替换）：
 *   - tools/kc_theme_inject.html（前台运行时替换，FEAT-017）
 *   - tools/xboard-patches/admin.blade.php 与 tools/_v123_admin_inject_script.html.tpl
 *     （管理端 KC-ADMIN-V2 运行时替换实现），按行模式放行注释描述行。
 *
 * 用法：node tools/check-currency.js   （有非白名单命中时退出码 1）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'tools/kc_theme_inject.html',
  'tools/kc_panel_inject.html',
  'tools/kc_activate_inject.html',
  'tools/_v123_admin_inject_script.html.tpl',
  'server.js',
  'kc-deploy_20261007.ps1',
  'kc-deploy_20261007.sh',
];
const DIRS = [
  { dir: 'public', ext: /\.html$/ },
  { dir: 'tools/xboard-patches', ext: /\.(php|json)$/ },
];
const TOKENS = ['¥', '￥', 'CNY', 'RMB', '人民币'];

const ALLOW_LINE = [
  { file: 'tools/kc_theme_inject.html', re: /FEAT-017|kcFixCurrency|货币|人民币|indexOf\(|split\(|换成|「¥|¥\/￥/ },
  { file: 'tools/xboard-patches/admin.blade.php', re: /KC-ADMIN-V2|文案兜底|货币（/ },
  { file: 'tools/xboard-patches/Epay/Plugin.php', re: /fiat|CNY|KC-PATCH|默认按/ },
  { file: 'tools/_v123_admin_inject_script.html.tpl', re: /KC-ADMIN-V2|文案兜底|货币（/ },
];

function allowed(rel, line) {
  return ALLOW_LINE.some((a) => rel === a.file && a.re.test(line));
}

function scanFile(file, hits) {
  let s;
  try { s = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const lines = s.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const t of TOKENS) {
      if (line.includes(t) && !allowed(rel, line)) {
        hits.push({ file, line: i + 1, token: t, snippet: line.trim().slice(0, 160) });
        break;
      }
    }
  }
}

(function main() {
  const hits = [];
  for (const f of FILES) scanFile(path.join(ROOT, f), hits);
  for (const d of DIRS) {
    const base = path.join(ROOT, d.dir);
    (function walk(dir) {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch (e) { return; }
      for (const e of entries) {
        const p = path.join(dir, e);
        let st; try { st = fs.statSync(p); } catch (err) { continue; }
        if (st.isDirectory()) walk(p);
        else if (d.ext.test(e)) scanFile(p, hits);
      }
    })(base);
  }

  console.log('== 货币显示检查（全站金额一律 $，不允许人民币符号/字样出现在显示面）==');
  if (!hits.length) {
    console.log('  [OK] 未发现人民币痕迹 ✓');
    process.exit(0);
  }
  for (const h of hits) {
    console.log('  [HIT] ' + path.relative(ROOT, h.file) + ':' + h.line + ' [' + h.token + '] ' + h.snippet);
  }
  console.log('发现问题 ' + hits.length + ' 处：如属「货币兜底替换实现」应更新 ALLOW_LINE，否则请改为 $ 展示。');
  process.exit(1);
})();
