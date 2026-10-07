// 段C5：写入 custom_html 并清缓存的一条龙脚本
//
// ⚠️ 为什么必须清缓存：Xboard 的 ThemeService::getConfig() 走 admin_setting()，
//    而 admin_setting() 会把配置缓存进 Laravel cache。只写 DB 不改缓存的话，
//    前台仍渲染旧内容 —— 表现为「写入了 19634 字符但页面里没有新逻辑」。
//
// 用法：node tools/xboard-apply-custom-html.js
const fs = require('fs');
const { execFileSync } = require('child_process');

const DOCKER = process.env.DOCKER || 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const PROJ = 'D:/tools/KC-PAY-GPT';

const run = (args, label) => {
  try {
    const out = execFileSync(DOCKER, args, { encoding: 'utf8' });
    if (label) console.log(`  [${label}] ${out.trim().slice(0, 400)}`);
    return out;
  } catch (e) {
    console.log(`  [${label}] !! ${(e.stdout || '') + (e.stderr || e.message)}`);
    return null;
  }
};

console.log('1) 拷源文件进容器');
run(['cp', `${PROJ}/tools/kc_activate_inject.html`, 'xboard:/www/kc_activate_inject.html']);
run(['cp', `${PROJ}/tools/kc_panel_inject.html`, 'xboard:/www/kc_panel_inject.html']);
run(['cp', `${PROJ}/tools/kc_theme_inject.html`, 'xboard:/www/kc_theme_inject.html']);
run(['cp', `${PROJ}/tools/xboard-set-custom-html.php`, 'xboard:/www/xboard-set-custom-html.php']);

console.log('2) 写入主题配置');
run(['exec', 'xboard', 'php', '/www/xboard-set-custom-html.php'], 'write');

console.log('3) 清缓存（关键：admin_setting() 会缓存配置）');
run(['exec', 'xboard', 'php', 'artisan', 'optimize:clear'], 'clear');

console.log('4) 重载 Octane');
run(['exec', 'xboard', 'php', 'artisan', 'octane:reload'], 'reload');

console.log('5) 验证首页输出');
const http = require('http');
setTimeout(() => {
  http.get('http://127.0.0.1:7001/', res => {
    let b = '';
    res.on('data', c => b += c);
    res.on('end', () => {
      console.log(`  首页 HTTP ${res.statusCode} 长度=${b.length}`);
      console.log(`  含 realProgress      : ${b.includes('realProgress') ? 'YES' : 'NO'}`);
      console.log(`  含 data-kc-progress  : ${b.includes('data-kc-progress') ? 'YES' : 'NO'}`);
      console.log(`  含 opt.progress 传参 : ${b.includes('progress: (typeof d.progress') ? 'YES' : 'NO'}`);
      console.log(`  含旧硬编码           : ${b.includes("bar.style.width = st.bar + '%'") ? 'YES（旧版残留！）' : 'NO'}`);
      console.log('\n完成');
    });
  }).on('error', e => console.log('  验证失败: ' + e.message));
}, 2500);
