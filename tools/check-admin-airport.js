// tools/check-admin-airport.js — v1.23.0 后台代充化断言（管理端）
// 用法：node tools/check-admin-airport.js
// 原理：真实登录 → 遍历保留页面 → 采集「可见文本」扫机场词典 → 专项断言 + 视口截图
// 说明：截图用视口模式（不用 captureBeyondViewport，避免重排触发 React 重建造成假象）
// 依据：docs/方案/Xboard原生功能处置清单-v1.0.0.md（隐藏项不得加回 / 保留项须代充化）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ⚠️ 已退役（v2.0.0 · Stage 3.9，不再执行）：本检查的目标是 Xboard 管理端（:7001），该容器已退场。
//    主站改由 KC 原生前台承载（:3100，GET /）；余额币种口径保留在 tools/check-currency.js（不依赖 Xboard）。
console.log('[retired] tools/check-admin-airport.js 已停用：Xboard(:7001) 已退场（Stage 3.9 / v2.0.0）。');
console.log('          主站为 KC 原生前台 :3100；币种口径见 tools/check-currency.js。');
process.exit(0);

const env = {};
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const EMAIL = env.ADMIN_TRIAL_EMAIL || 'kcbugtest@example.com';
const PASS = env.ADMIN_TRIAL_PASS || 'KcBug@2026';

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(__dirname, '..', 'logs', 'admin-airport', TS);
const PROF = 'C:/Users/shizi/AppData/Local/Temp/kc_airport_' + Date.now();
const PORT = 9512;
const BASE = 'http://localhost:7001';
const ADMIN = BASE + '/5fea4ca1';

// 机场专有词词典（对「可见文本」断言 0 命中）
const LEXICON = /订阅|节点|流量|折抵|倍率|权限组|在线设备|设备限制|CNY|机场|月上传|月下载|线路|中转|元\/|\(元\)|（元）/;
// 允许的例外（命中后过滤：这些文本在保留面上是合理/已确认的）
const ALLOW = []; // 目前无例外；如需临时放行在此追加子串

const PAGES = [
    { name: 'dashboard', url: '', asserts: ["!¥", "'KC 直供'", "no:月上传", "no:节点流量排行"] },
    { name: 'plan', url: '/#/finance/plan', asserts: ["'商品套餐'", "'充值包'", "no列:权限组", "no:¥"] },
    { name: 'order', url: '/#/finance/order', asserts: ["'商品名称'", "'服务周期'", "no:¥"] },
    { name: 'user', url: '/#/user/manage', asserts: ["'当前商品'", "no列:到期时间", "no:¥"] },
    { name: 'system', url: '/#/config/system', asserts: ["'站点设置'", "noTab:订阅设置", "noTab:节点配置", "noTab:订阅模板"] },
    { name: 'notice', url: '/#/config/notice', asserts: [] },
    { name: 'payment', url: '/#/config/payment', asserts: ["'USDT'"] },
    { name: 'ticket', url: '/#/user/ticket', asserts: [] }
];

fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); });

const report = { pages: [], summary: { pass: 0, fail: 0, hits: 0 }, console: [] };

// 页面内注入的可见文本采集器（排除 display:none / visibility:hidden）
const VISIBLE_TEXT_FN = `(function(){
  var cache = new WeakMap();
  function vis(el){
    if(!el || el===document.body) return true;
    if(cache.has(el)) return cache.get(el);
    var st = getComputedStyle(el);
    var v = st.display!=='none' && st.visibility!=='hidden';
    if(v && el.parentElement) v = vis(el.parentElement);
    cache.set(el,v);
    return v;
  }
  var out=[];
  var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);
  var n;
  while((n=walker.nextNode())){
    var t=(n.nodeValue||'').trim();
    if(!t) continue;
    if(!vis(n.parentElement)) continue;
    out.push(t);
  }
  return out.join('\\n');
})()`;

const VISIBLE_TH_FN = `(function(){
  var out=[]; var ths=document.querySelectorAll('thead th');
  for(var i=0;i<ths.length;i++){
    var el=ths[i]; var hidden=false; var p=el;
    while(p && p!==document.body){ var st=getComputedStyle(p); if(st.display==='none'||st.visibility==='hidden'){hidden=true;break;} p=p.parentElement; }
    if(!hidden) out.push((el.textContent||'').replace(/\\s+/g,' ').trim());
  }
  return out.join('|');
})()`;

const INPUTS_FN = `(function(){
  var out=[]; var ins=document.querySelectorAll('input');
  for(var i=0;i<ins.length&&out.length<40;i++){ var v=ins[i].value; if(v) out.push(v.slice(0,60)); }
  return out.join('\\n');
})()`;

(async () => {
    const ch = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
        '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
        '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
    let wsUrl = null;
    for (let i = 0; i < 40; i++) { await sleep(500); try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/version')).webSocketDebuggerUrl; if (wsUrl) break; } catch (e) { } }
    if (!wsUrl) { console.error('Chrome 未就绪'); ch.kill(); process.exit(1); }
    const WebSocket = require('C:/Users/shizi/.workbuddy/binaries/node/workspace/node_modules/ws');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const waiting = new Map();
    ws.on('message', r => {
        let m; try { m = JSON.parse(r.toString()); } catch (e) { return; }
        if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params && m.params.exceptionDetails;
            report.console.push('EXCEPTION: ' + String(d && d.text || '').slice(0, 200));
        }
    });
    const send = (me, pa, si) => new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa || {}, sessionId: si })); });
    const tab = await send('Target.createTarget', { url: 'about:blank' });
    const sid = (await send('Target.attachToTarget', { targetId: tab.result.targetId, flatten: true })).result.sessionId;
    await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid);
    const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }, sid); if (r.result && r.result.exceptionDetails) return 'EVALERR: ' + String(r.result.exceptionDetails.text).slice(0, 200); return r.result && r.result.result ? r.result.result.value : null; };
    const shotViewport = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }, sid); if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); };
    const typeText = async t => { await send('Input.insertText', { text: t }, sid); };
    const key = async (k, code, vk) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid); };
    const clickAt = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid); };

    try {
        // ===== 登录 =====
        await send('Page.navigate', { url: ADMIN }, sid); await sleep(6000);
        const em = await ev("(function(){var ins=document.querySelectorAll('input');for(var i=0;i<ins.length;i++){var e=ins[i];if(e.type!=='password'&&e.offsetParent!==null){var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return null;})()");
        if (em) { const b = JSON.parse(em); await clickAt(b.x, b.y); await sleep(250); await typeText(EMAIL); await sleep(350); }
        const pw = await ev("(function(){var e=document.querySelector('input[type=password]');if(!e)return null;var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()");
        if (pw) { const b = JSON.parse(pw); await clickAt(b.x, b.y); await sleep(250); await typeText(PASS); await sleep(400); }
        const btn = await ev("(function(){var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++){var t=(bs[i].textContent||'').trim();if(/^(登录|登入|Login|Sign in)$/i.test(t)){var r=bs[i].getBoundingClientRect();if(r.width>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return null;})()");
        if (btn) { const c = JSON.parse(btn); await clickAt(c.x, c.y); } else { await key('Enter', 'Enter', 13); }
        let ok = false;
        for (let i = 0; i < 40; i++) { await sleep(500); if (await ev("!!document.querySelector('nav')")) { ok = true; break; } }
        console.log('登录:', ok ? 'ok' : 'FAIL');
        if (!ok) { report.summary.fail++; throw new Error('登录失败'); }
        await sleep(2500);

        // ===== 侧栏全局断言 =====
        const sideText = await ev(VISIBLE_TEXT_FN);
        const sideAsserts = {
            "sidebar '商品管理' 可见": sideText.indexOf('商品管理') >= 0,
            "sidebar '节点管理' 不可见": sideText.indexOf('节点管理') < 0,
            "sidebar '订阅管理' 不可见": sideText.indexOf('订阅管理') < 0,
            "sidebar '权限组管理' 不可见": sideText.indexOf('权限组管理') < 0
        };
        report.pages.push({ name: 'sidebar', asserts: sideAsserts, hits: scanLex(sideText) });

        // ===== 逐页 =====
        for (const p of PAGES) {
            const url = ADMIN + p.url;
            await send('Page.navigate', { url }, sid); await sleep(4200);
            const vt = (await ev(VISIBLE_TEXT_FN)) || '';
            const ths = (await ev(VISIBLE_TH_FN)) || '';
            const inputs = (await ev(INPUTS_FN)) || '';
            await shotViewport(p.name);

            const hits = scanLex(vt);
            const asserts = {};
            // 专项断言解析
            for (const a of p.asserts) {
                if (a === '!¥') asserts[a] = vt.indexOf('\u00a5') < 0;
                else if (a.indexOf("'") === 0) asserts[a] = vt.indexOf(a.slice(1, -1)) >= 0;
                else if (a.indexOf('no:') === 0) asserts[a] = vt.indexOf(a.slice(3)) < 0;
                else if (a.indexOf('no列:') === 0) asserts[a] = ths.indexOf(a.slice(4)) < 0;
                else if (a.indexOf('noTab:') === 0) asserts[a] = vt.indexOf(a.slice(6)) < 0;
            }
            if (p.name === 'system') { asserts["站点名称='KC 直供'"] = inputs.indexOf('KC 直供') >= 0; }
            report.pages.push({ name: p.name, url, hits, asserts, thTexts: ths.slice(0, 300) });

            const fails = Object.entries(asserts).filter(([k, v]) => !v).map(([k]) => k);
            console.log('—— ' + p.name + ' | 命中 ' + hits.length + ' | 断言 ' + (Object.keys(asserts).length - fails.length) + '/' + Object.keys(asserts).length + (fails.length ? ' | FAIL: ' + fails.join('; ') : ''));
            hits.slice(0, 10).forEach(h => console.log('    ', h));
        }

        // ===== 系统配置页签遍历（每个保留页签扫可见文本） =====
        await send('Page.navigate', { url: ADMIN + '/#/config/system' }, sid); await sleep(4200);
        const TABS = ['站点设置', '安全设置', '邀请&佣金设置', '邮件设置', 'Telegram设置', 'APP设置'];
        const tabHits = [];
        for (const tab of TABS) {
            const clicked = await ev("(function(){var all=document.querySelectorAll('a,button');for(var i=0;i<all.length;i++){if((all[i].textContent||'').trim()==='" + tab + "'){var r=all[i].getBoundingClientRect();if(r.width>0){all[i].click();return 'ok';}}}return 'nf';})()");
            await sleep(1400);
            const tv = (await ev(VISIBLE_TEXT_FN)) || '';
            const hits = scanLex(tv);
            hits.forEach(h => tabHits.push(tab + ': ' + h));
            console.log('—— system-tab[' + tab + '] | 命中 ' + hits.length + ' | click=' + clicked);
            hits.slice(0, 6).forEach(h => console.log('    ', h));
        }
        // 已知残留：邀请&佣金设置页存在「提现单申请门槛($)」文本（i18n 覆盖，非 space-y 容器，
        // 壳层 HIDE_LABELS 的 cleanLabelRows() 对其不生效）。该页签整体随 Stage 3 Xboard 退场消失，
        // 故此处不作硬断言，仅登记于 docs/方案/Xboard原生功能处置清单-v1.0.0.md「已知残留」。
        report.pages.push({
            name: 'system-tabs', hits: tabHits, asserts: {
                '全部保留页签 0 命中': tabHits.length === 0
            }
        });
        await shotViewport('system_tabs_done');

        // ===== 交互验证 A：用户行操作菜单 =====
        await send('Page.navigate', { url: ADMIN + '/#/user/manage' }, sid); await sleep(4200);
        const rowBtn = await ev("(function(){var rows=document.querySelectorAll('tbody tr');if(!rows.length)return null;var tds=rows[0].querySelectorAll('td');var last=tds[tds.length-1];var bs=last.querySelectorAll('button');if(!bs.length)return null;var b=bs[0].getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()");
        if (rowBtn && rowBtn.indexOf('{') === 0) {
            const c = JSON.parse(rowBtn); await clickAt(c.x, c.y); await sleep(1300);
            await shotViewport('u_row_menu');
            const menuText = (await ev("(function(){var items=document.querySelectorAll('[role=\"menuitem\"]');var out=[];for(var i=0;i<items.length;i++){var st=getComputedStyle(items[i]);if(st.display!=='none')out.push((items[i].textContent||'').trim());}return out.join('|');})()")) || '';
            report.pages.push({
                name: 'user-row-menu', asserts: {
                    "菜单无 '复制订阅URL'": menuText.indexOf('复制订阅URL') < 0,
                    "菜单无 '重置UUID及订阅URL'": menuText.indexOf('重置UUID及订阅URL') < 0,
                    "菜单无 '重置流量'": menuText.indexOf('重置流量') < 0,
                    "菜单无 'TA的流量记录'": menuText.indexOf('TA的流量记录') < 0
                }, sample: menuText.slice(0, 200)
            });
            console.log('—— user-row-menu | 可见项: ' + menuText.slice(0, 160));
            await key('Escape', 'Escape', 27); await sleep(600);
        } else {
            report.pages.push({ name: 'user-row-menu', skipped: '未找到行操作按钮' });
            console.log('—— user-row-menu | SKIP（未找到行操作按钮）');
        }

        // ===== 交互验证 B：套餐编辑弹窗 =====
        await send('Page.navigate', { url: ADMIN + '/#/finance/plan' }, sid); await sleep(4200);
        const editBtn = await ev("(function(){var rows=document.querySelectorAll('tbody tr');if(!rows.length)return null;var tds=rows[0].querySelectorAll('td');var last=tds[tds.length-1];var bs=last.querySelectorAll('button');if(bs.length<2)return null;var b=bs[0].getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),n:bs.length});})()");
        if (editBtn && editBtn.indexOf('{') === 0) {
            const c = JSON.parse(editBtn); await clickAt(c.x, c.y); await sleep(2200);
            const dlgText = (await ev("(function(){var dlg=document.querySelector('[role=\"dialog\"]');if(!dlg)return '';var out=[];var all=dlg.querySelectorAll('label,button');for(var i=0;i<all.length;i++){var r=all[i].getBoundingClientRect();if(r.width===0&&r.height===0)continue;out.push((all[i].textContent||'').trim());}return out.join('|');})()")) || '';
            await shotViewport('plan_dialog');
            report.pages.push({
                name: 'plan-dialog', asserts: {
                    "弹窗无 '流量'": !/^\u6d41\u91cf$/.test(dlgText) && dlgText.split('|').indexOf('流量') < 0,
                    "弹窗无 '设备限制'": dlgText.indexOf('设备限制') < 0,
                    "弹窗无 '流量重置方式'": dlgText.indexOf('流量重置方式') < 0,
                    "弹窗无 '服务器分组'": dlgText.indexOf('服务器分组') < 0
                }, sample: dlgText.slice(0, 300)
            });
            console.log('—— plan-dialog | label/按钮: ' + dlgText.slice(0, 200));
            await key('Escape', 'Escape', 27); await sleep(600);
        } else {
            report.pages.push({ name: 'plan-dialog', skipped: '未找到编辑按钮' });
            console.log('—— plan-dialog | SKIP');
        }

    } catch (e) {
        report.console.push('FATAL: ' + e.message);
        console.error('异常:', e.message);
    } finally {
        // 汇总
        for (const pg of report.pages) {
            if (pg.hits) report.summary.hits += pg.hits.length;
            if (pg.asserts) {
                for (const v of Object.values(pg.asserts)) { if (v) report.summary.pass++; else report.summary.fail++; }
            }
        }
        fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
        console.log('');
        console.log('===== 汇总 =====');
        console.log('PASS:', report.summary.pass, '| FAIL:', report.summary.fail, '| 词典命中:', report.summary.hits);
        console.log('报告:', path.join(OUT, 'report.json'));
        try { ws.close(); } catch (e) { }
        try { ch.kill(); } catch (e) { }
        await sleep(800);
    }
    process.exit(report.summary.fail > 0 ? 2 : 0);
})().catch(e => { console.error('外层异常:', e.message); process.exit(1); });

function scanLex(text) {
    const hits = [];
    (text || '').split('\n').forEach(l => {
        const t = l.trim();
        if (t && LEXICON.test(t) && !ALLOW.some(a => t.indexOf(a) >= 0)) hits.push(t.slice(0, 100));
    });
    return [...new Set(hits)];
}
