// FEAT-005 一键回滚：把 custom_html 恢复到写入前备份（S1 前，56133 字符版本）
//
// ⚠️ 已退役（v2.0.0 · Stage 3.9）：Xboard 已退场、注入已清除（custom_html=空）。本脚本不再日常使用。
//    注意：Stage 3 的回滚方向与本文相反（要「恢复注入」用 tools/xboard-apply-custom-html.js）。
//
// 用法：node tools/xboard-restore-custom-html.js [_backup_custom_html_20260924.txt]
//   缺省用 S1 写入前的备份。恢复后自动 optimize:clear + octane:reload。
// 原理：备份文件内容整体作为 custom_html 写回主题配置（与 apply 同一条龙）。
const fs = require('fs');
const { execFileSync } = require('child_process');

const DOCKER = process.env.DOCKER || 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const PROJ = 'D:/tools/KC-PAY-GPT';
const BAK = process.argv[2] || PROJ + '/tools/_backup_custom_html_20260924.txt';

if (!fs.existsSync(BAK)) { console.log('备份文件不存在: ' + BAK); process.exit(1); }
const content = fs.readFileSync(BAK, 'utf8');
console.log('备份文件: ' + BAK + ' (' + Buffer.byteLength(content) + ' 字符)');

const run = (args, label) => {
  try {
    const out = execFileSync(DOCKER, args, { encoding: 'utf8' });
    if (label) console.log(`  [${label}] ${out.trim().slice(0, 300)}`);
    return out;
  } catch (e) {
    console.log(`  [${label}] !! ${(e.stdout || '') + (e.stderr || e.message)}`);
    return null;
  }
};

// 1) 备份内容送进容器
fs.writeFileSync(PROJ + '/tools/_restore_payload.txt', content);
run(['cp', PROJ + '/tools/_restore_payload.txt', 'xboard:/www/_restore_payload.txt'], 'cp');

// 2) 写回（用 tinker 恢复 ThemeService 配置）
const php = `<?php
$c = file_get_contents('/www/_restore_payload.txt');
\\App\\Services\\ThemeService::updateConfig($c, 'Xboard');
echo 'restore done, len=' . strlen($c) . PHP_EOL;
echo 'kcThemeLoaded in config: ' . (strpos(\\App\\Services\\ThemeService::getConfig('Xboard')['custom_html'] ?? '', 'kcThemeLoaded') !== false ? 'YES(未回滚?)' : 'NO(已回滚)') . PHP_EOL;
`;
fs.writeFileSync(PROJ + '/tools/_restore_payload.php', php);
run(['cp', PROJ + '/tools/_restore_payload.php', 'xboard:/www/_restore_payload.php'], 'cp-php');
run(['exec', 'xboard', 'php', '/www/_restore_payload.php'], 'restore');

// 3) 清缓存 + 重载
run(['exec', 'xboard', 'php', 'artisan', 'optimize:clear'], 'clear');
run(['exec', 'xboard', 'php', 'artisan', 'octane:reload'], 'reload');

// 4) 验证
const http = require('http');
setTimeout(() => {
  http.get('http://127.0.0.1:7001/', res => {
    let b = '';
    res.on('data', c => b += c);
    res.on('end', () => {
      console.log(`首页 HTTP ${res.statusCode} 长度=${b.length}`);
      console.log(`含主题注入(kcThemeLoaded): ${b.includes('kcThemeLoaded') ? 'YES(未回滚!)' : 'NO(已回滚 ✓)'}`);
      console.log(`含兑卡面板(kcPanelLoaded) : ${b.includes('kcPanelLoaded') ? 'YES ✓' : 'NO(!)'}`);
      console.log(`含激活注入(realProgress)  : ${b.includes('realProgress') ? 'YES ✓' : 'NO(!)'}`);
    });
  }).on('error', e => console.log('验证失败: ' + e.message));
}, 2500);
