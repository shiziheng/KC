const fs = require('fs');
const { execFileSync } = require('child_process');
const R = 'D:/tools/KC-PAY-GPT';

// 只删除我自己创建的临时诊断脚本（_ 开头，确保不含业务文件）
const tempFiles = [
  '_check_state.js', '_check_diff.js', '_reset_index.js', '_verify_final.js',
  '_diff_check.js', '_head_check.js', '_full_status.js', '_readme_diff.txt',
  '_index_list.txt', '_probe.txt', '_procs.txt'
];

console.log('=== 1. 删除我的临时诊断文件（仅 _ 前缀，不含业务文件）===');
let removed = 0;
for (const f of tempFiles) {
  const fp = R + '/' + f;
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
    removed++;
    console.log('  ✓ 删除 ' + f);
  }
}
console.log('  共删除 ' + removed + ' 个');

console.log('\n=== 2. 删除陈旧 index 并重新暂存全部（刷新 blob，修复 invalid object）===');
// 删除 .git/index（可重建，不动工作区）
try {
  fs.unlinkSync(R + '/.git/index');
  console.log('  ✓ 已删除 .git/index');
} catch (e) {
  console.log('  index 不存在或已删: ' + e.message);
}

function run(args) {
  try {
    return execFileSync('git', args, { cwd: R, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

run(['add', '-A']);
const staged = run(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
console.log('  重新暂存文件数:', staged.length);

console.log('\n=== 3. 垃圾复查（确认无漏网）===');
const junk = staged.filter(f =>
  /(_d4prof|_d4prof_b|_fix1_out|_reg_result|_ux_notes|\.dmp|\.tflite|\.git_broken_backup|node_modules|\/\.next\/|_check_|_verify_|_diff_|_reset_|_head_|_full_|_index_list|_probe\.txt|_procs\.txt|api\.md)/.test(f)
);
console.log('  漏网垃圾:', junk.length ? '\n    ' + junk.slice(0, 15).join('\n    ') : '无 ✓');

console.log('\n=== 4. 关键目录纳入确认 ===');
['business', 'business-infra', 'domain', 'fulfillment', 'public', 'docs', 'web', 'tools', '.githooks'].forEach(d => {
  const n = staged.filter(f => f === d || f.startsWith(d + '/')).length;
  console.log('  ' + d + ': ' + (n ? n + ' 文件' : (d === 'domain' || d === 'fulfillment') ? '未纳入（磁盘确实缺失）' : '未纳入(!)'));
});

console.log('\n=== 5. 验证暂存区 blob 全部可解（写树前关键）===');
// 抽样前 50 个文件的 blob 是否可被 cat-file 读取
let badCount = 0, checked = 0;
for (const f of staged.slice(0, 50)) {
  const sha = run(['ls-files', '-s', f]).split(/\s+/)[1];
  if (!sha) continue;
  checked++;
  try {
    execFileSync('git', ['cat-file', '-e', sha], { cwd: R, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (e) {
    badCount++;
    if (badCount <= 5) console.log('    ✗ 不可解: ' + f + ' (' + sha.slice(0, 10) + ')');
  }
}
console.log('  抽样 ' + checked + ' 个, 不可解 blob: ' + badCount + (badCount === 0 ? ' ✓ 全部可解' : ''));
