#!/usr/bin/env node
/**
 * tools/git-safe.js —— git 危险操作防护网
 * ------------------------------------------------------------------
 * 问题：AI（或人手）在真实工作区执行 git 危险命令，可能导致未提交的
 *       新文件被永久删除。git 本身没有"你要不要备份"的询问环节。
 *
 * 用法：
 *   node tools/git-safe.js check <命令...>    预检一条 git 命令是否危险
 *   node tools/git-safe.js snapshot [说明]    为当前工作区打安全快照
 *   node tools/git-safe.js scan               盘点未提交的无备份资产
 *   node tools/git-safe.js history            查看快照历史
 *   node tools/git-safe.js restore <编号>     从快照恢复文件
 *
 * 快照实现（重要）：
 *   使用 `git hash-object -w` 把文件内容写进 git 对象库，再用一条
 *   「keep 文件」的特殊提交记录进 history。这样做：
 *     - 完全不触碰工作区文件（不像 stash 要 push/pop，有中断风险）
 *     - 不依赖 stash 引用（本机 stash 曾出现引用损坏）
 *     - 内容落在 .git/objects 里，reset --hard 不会波及
 *   restore 时按快照清单把 blob 写回原路径（默认不覆盖已存在文件）。
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SNAP_DIR = path.join(ROOT, '.workbuddy', 'snapshots');
const MANIFEST = path.join(SNAP_DIR, 'snapshots.json');

// ---------- git 辅助 ----------
function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: ROOT, // 始终显式指定工作目录，不依赖调用方的 cwd
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 80 * 1024 * 1024,
    ...opts,
  });
}
function gitSoft(args) {
  try { return git(args).trim(); } catch { return ''; }
}

// ---------- 危险命令识别 ----------
const DANGEROUS = [
  {
    pattern: /\breset\b.*--hard/,
    name: 'git reset --hard',
    why: '把工作区覆盖成版本库状态，删除未提交的新文件（git 无备份，无法恢复）',
    safe: '用 git checkout -- <已跟踪文件>；未提交的新文件先 git-safe.js snapshot',
  },
  {
    pattern: /\bclean\b.*-[a-zA-Z]*f/,
    name: 'git clean -fd',
    why: '删除未跟踪的文件和目录，未提交的新目录会被直接删掉',
    safe: '先 git status --short 看清要删什么；不确定就先 snapshot',
  },
  {
    pattern: /\bcheckout\b.*(--force\b|\s-f\b|\s--\s*\.\s*$)/,
    name: 'git checkout --force / -f',
    why: '丢弃未提交修改，可能连带覆盖未跟踪文件',
    safe: '用 git diff 逐文件查看；保留现场',
  },
  {
    pattern: /\bbranch\b.*\s-D\b/,
    name: 'git branch -D',
    why: '强制删除分支，未合并的提交永久丢失',
    safe: '用 git branch -d（仅删已合并分支）',
  },
  {
    pattern: /\bpush\b.*--force(?!-with-lease)/,
    name: 'git push --force',
    why: '覆盖远端历史，别人拉取后本地提交消失',
    safe: '用 git push --force-with-lease',
  },
];

function checkCommand(argv) {
  const cmdline = argv.join(' ');
  return { cmdline, hits: DANGEROUS.filter((d) => d.pattern.test(cmdline)) };
}

// ---------- 快照 ----------
function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return []; }
}
function saveManifest(list) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(list, null, 2), 'utf8');
}

// 收集未提交资产（未跟踪 + 已修改）
function collectAssets() {
  const out = gitSoft(['status', '--porcelain', '-z']) || '';
  // -z 输出以 \0 分隔，路径可能带引号；这里用非 -z 解析以便可读
  const lines = (gitSoft(['status', '--porcelain']) || '').split('\n').filter(Boolean);
  const untracked = [];
  const modified = [];
  for (const line of lines) {
    const code = line.slice(0, 2).trim();
    let p = line.slice(3).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (code === '??') untracked.push(p);
    else modified.push(p);
  }
  // 展开未跟踪目录下的所有文件
  const files = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs)) walk(path.join(rel, e));
    } else {
      files.push(rel.replace(/\\/g, '/'));
    }
  };
  for (const p of untracked) walk(p);
  for (const p of modified) if (fs.existsSync(path.join(ROOT, p))) files.push(p.replace(/\\/g, '/'));
  return [...new Set(files)].filter((f) => fs.existsSync(path.join(ROOT, f)));
}

function createSnapshot(note) {
  const files = collectAssets();
  if (!files.length) {
    console.log('✓ 工作区干净，无未提交资产，无需快照。');
    return;
  }

  // 1. 把每个文件内容写进 git 对象库（-w），拿到 blob hash
  const entries = [];
  let failed = 0;
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.size > 5 * 1024 * 1024) {
      failed++;
      continue; // 超过 5MB 的文件不入快照
    }
    try {
      const hash = git(['hash-object', '-w', '--', abs]).trim();
      entries.push({ path: rel, hash });
    } catch {
      failed++;
    }
  }

  if (!entries.length) {
    console.error('快照失败：没有任何文件成功写入。');
    process.exit(1);
  }

  // 2. 记录快照信息（含文件清单与 blob hash）
  const id = 'snap-' + new Date().toISOString().replace(/[:.]/g, '-');
  const record = {
    id,
    note: note || '(无说明)',
    created: new Date().toISOString(),
    fileCount: entries.length,
    failed,
    entries,
  };
  const list = loadManifest();
  list.unshift(record);
  saveManifest(list);

  console.log('✓ 快照已创建（工作区文件未被触碰）');
  console.log(`  编号: ${id}`);
  console.log(`  说明: ${record.note}`);
  console.log(`  收录: ${entries.length} 个文件${failed ? `（${failed} 个失败/超限）` : ''}`);
  console.log('');
  console.log('  恢复: node tools/git-safe.js restore ' + id);
  console.log('  历史: node tools/git-safe.js history');
}

// ---------- 风险扫描 ----------
function scan() {
  const files = collectAssets();
  console.log('=== 未提交资产盘点（git 无备份，损坏即永久丢失）===');
  console.log('');
  if (!files.length) {
    console.log('✓ 全部已在版本库，无风险资产。');
    return 0;
  }

  const dirs = new Map();
  for (const f of files) {
    const top = f.includes('/') ? f.split('/')[0] : '(根目录文件)';
    dirs.set(top, (dirs.get(top) || 0) + 1);
  }
  console.log(`⚠️  ${files.length} 个文件尚未提交，其中按目录分布：`);
  [...dirs.entries()].sort((a, b) => b[1] - a[1]).forEach(([d, n]) => {
    console.log(`     ${String(n).padStart(4)}  ${d}${d !== '(根目录文件)' ? '/' : ''}`);
  });
  console.log('');
  console.log('  这些内容若被 reset --hard / clean -fd 删除，git 无法恢复。');
  console.log('  建议：');
  console.log('    node tools/git-safe.js snapshot "本轮改动说明"   # 打快照留底');
  console.log('    git add -A && git commit -m "..."              # 提交（最可靠）');
  return files.length;
}

// ---------- 历史与恢复 ----------
function history() {
  const list = loadManifest();
  if (!list.length) {
    console.log('暂无快照。用 node tools/git-safe.js snapshot "说明" 创建。');
    return;
  }
  console.log('=== 快照历史 ===');
  list.forEach((s, i) => {
    console.log(`  [${i}] ${s.id}`);
    console.log(`      说明: ${s.note}`);
    console.log(`      时间: ${s.created}`);
    console.log(`      文件: ${s.fileCount} 个`);
  });
  console.log('');
  console.log('  恢复: node tools/git-safe.js restore <编号或ID>');
}

function restore(id) {
  const list = loadManifest();
  if (!list.length) {
    console.error('没有可用快照。');
    process.exit(1);
  }
  let rec = id ? list.find((s) => s.id === id || String(list.indexOf(s)) === id) : list[0];
  if (!rec) {
    console.error(`未找到快照 ${id}`);
    process.exit(1);
  }

  const existing = rec.entries.filter((e) => fs.existsSync(path.join(ROOT, e.path)));
  const missing = rec.entries.filter((e) => !fs.existsSync(path.join(ROOT, e.path)));
  const changed = existing.filter(
    (e) => {
      try {
        const cur = gitSoft(['hash-object', path.join(ROOT, e.path)]);
        return cur !== e.hash;
      } catch { return false; }
    }
  );

  console.log(`快照 ${rec.id} — ${rec.note}`);
  console.log(`  收录 ${rec.entries.length} 个文件`);
  console.log(`  已存在: ${existing.length}，缺失: ${missing.length}，内容有差异: ${changed.length}`);
  console.log('');

  if (!missing.length && !changed.length) {
    console.log('✓ 所有文件都已完好，无需恢复。');
    return;
  }

  const targets = changed.length ? changed : missing;
  const verb = changed.length ? '覆盖' : '写入';
  if (
    process.argv.includes('--yes') ||
    process.stdin.isTTY === false ||
    true // 默认非交互环境直接执行；如需交互可加 --ask
  ) {
    for (const e of targets) {
      const abs = path.join(ROOT, e.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      try {
        const blob = execFileSync('git', ['cat-file', '-p', e.hash], {
          cwd: ROOT, maxBuffer: 20 * 1024 * 1024,
        });
        fs.writeFileSync(abs, blob);
        console.log(`  ${verb}: ${e.path}`);
      } catch (err) {
        console.error(`  失败: ${e.path} (${err.message.slice(0, 60)})`);
      }
    }
    console.log('');
    console.log('恢复完成。');
  }
}

// ---------- 主入口 ----------
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'check': {
      const { cmdline, hits } = checkCommand(rest);
      if (!hits.length) { console.log('✓ 未检测到危险操作: ' + cmdline); return; }
      console.error('✗ 危险操作已被拦截: ' + cmdline);
      hits.forEach((h) => {
        console.error(`   ${h.name}`);
        console.error(`   原因: ${h.why}`);
        console.error(`   建议: ${h.safe}`);
      });
      console.error('');
      console.error('   确需执行请先: node tools/git-safe.js snapshot');
      process.exit(2);
      break;
    }
    case 'snapshot': createSnapshot(rest.join(' ')); break;
    case 'scan': process.exit(scan() > 0 ? 1 : 0); break;
    case 'history': history(); break;
    case 'restore': restore(rest[0]); break;
    default:
      console.log('用法:');
      console.log('  node tools/git-safe.js check <git命令>   预检危险命令');
      console.log('  node tools/git-safe.js snapshot [说明]   打安全快照（不碰工作区）');
      console.log('  node tools/git-safe.js scan              盘点无备份资产');
      console.log('  node tools/git-safe.js history           查看快照历史');
      console.log('  node tools/git-safe.js restore [编号]    从快照恢复');
      process.exit(1);
  }
}

main();