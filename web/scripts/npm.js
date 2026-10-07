#!/usr/bin/env node
/**
 * npm 便捷入口
 *
 * 本机环境限制：npm 不能直接调用（PATH 里没有，且 PowerShell 下静默失败），
 * 必须通过 managed node 的 npm-cli.js 运行。这个脚本把这层封装掉。
 *
 * 用法（在 web/ 目录下）：
 *   node scripts/npm.js install
 *   node scripts/npm.js run dev
 *   node scripts/npm.js run build
 *   node scripts/npm.js run typecheck
 *
 * 默认走淘宝源（官方源的 next 元数据有 30MB，安装很慢）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  'C:/Users/shizi/.workbuddy/binaries/node/versions/22.22.2-3/node_modules/npm/bin/npm-cli.js',
];

const npmCli = CANDIDATES.find((p) => fs.existsSync(p));
if (!npmCli) {
  console.error('找不到 npm-cli.js，请检查 node 安装路径');
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法: node scripts/npm.js <install|run dev|run build|...>');
  process.exit(1);
}

// install / ci 默认补上镜像源
const isInstall = args[0] === 'install' || args[0] === 'ci' || args[0] === 'i';
if (isInstall && !args.some((a) => a.startsWith('--registry'))) {
  args.push('--registry=https://registry.npmmirror.com');
}
if (isInstall && !args.includes('--no-audit')) {
  args.push('--no-audit', '--no-fund');
}

const nodeExe = process.execPath;
const r = spawnSync(nodeExe, [npmCli, ...args], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
});
process.exit(r.status === null ? 1 : r.status);
