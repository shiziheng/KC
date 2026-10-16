// tools/check-airport-lexicon.js
// KC-PAY-GPT · L4 机场字段断言工具（SP-2026-10-12-v1.1.0 §3.4）
// 用途：登录测试账号 → 遍历用户可达面 → 采集「真正可见文本」（排除 display:none / visibility:hidden / opacity:0）
//       → 机场词典断言（0 命中即通过）+ 订单两页/个人中心/菜单/路由 专项断言。
// 用法：node tools/check-airport-lexicon.js [--url=http://localhost:7001]
// 退出码：0=全部通过；1=有断言失败；2=执行异常
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ⚠️ 已退役（v2.0.0 · Stage 3.9，不再执行）：本检查的目标是 Xboard 前台（:7001），该容器已退场。
//    主站改由 KC 原生前台承载（:3100，GET /）；机场词典口径由前台文案静态评审覆盖，
//    币种口径保留在 tools/check-currency.js（不依赖 Xboard）。
console.log('[retired] tools/check-airport-lexicon.js 已停用：Xboard(:7001) 已退场（Stage 3.9 / v2.0.0）。');
console.log('          主站为 KC 原生前台 :3100；币种口径见 tools/check-currency.js。');
process.exit(0);

const BASE = ((process.argv.find(a => a.indexOf('--url=') === 0) || '').split('=')[1]) || 'http://localhost:7001';
const EMAIL = process.env.KC_CHECK_EMAIL || 'kcbugtest@example.com';
const PASS = process.env.KC_CHECK_PASS || 'KcBug@2026';
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(__dirname, '..', 'logs', 'airport-lexicon', TS);
const PROF = 'C:/Users/shizi/AppData/Local/Temp/kc_lex_prof_' + Date.now();
const PORT = 9505;

// 机场语义词典（断言用；0 命中即通过）
// 「订阅」为裸词收录：ChatGPT 本身是订阅制产品，业务文案存在合法用法 → 用白名单豁免
const LEXICON = /流量|订阅|节点|折抵|续费|倍率|机场|CNY|月付|季付|年付/;
const LEXICON_ALLOW = /开通订阅|含订阅|新订阅/g;   // 合法业务文案白名单（ChatGPT 订阅语境）

fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); });

// 浏览器端：采集真正可见文本（display:none / visibility:hidden / opacity:0 沿祖先链排除）
const VT_FN = [
    '(function(){',
    'function vis(el){',
    'while(el&&el.nodeType===1){',
    'try{var cs=window.getComputedStyle(el);if(cs.display==="none"||cs.visibility==="hidden"||parseFloat(cs.opacity)===0)return false;}catch(e){}',
    'if(el===document.body)break;el=el.parentElement;',
    '}',
    'return true;',
    '}',
    'var out=[];',
    'var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);',
    'var n;',
    'while((n=w.nextNode())){',
    'var v=(n.nodeValue||"").trim();',
    'if(!v)continue;',
    'if(!vis(n.parentElement))continue;',
    'out.push(v);',
    '}',
    'return out.join(String.fromCharCode(10));',
    '})()'
].join('\n');

const report = { ts: new Date().toISOString(), base: BASE, checks: [], pages: [], errors: [] };
let failCount = 0;
function addCheck(name, ok, detail) {
    report.checks.push({ name, ok: !!ok, detail: detail || '' });
    if (!ok) failCount++;
    console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  | ' + String(detail).slice(0, 260) : ''));
}
function scan(text) {
    const hits = [];
    (text || '').split('\n').forEach(l => {
        const t = l.trim();
        if (!t) return;
        const probe = t.replace(LEXICON_ALLOW, '');
        if (LEXICON.test(probe)) hits.push(t.slice(0, 90));
    });
    return [...new Set(hits)];
}

(async () => {
    const ch = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
        '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
        '--window-size=1400,950', 'about:blank'], { stdio: 'ignore' });
    let wsUrl = null;
    for (let i = 0; i < 40; i++) { await sleep(500); try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/version')).webSocketDebuggerUrl; if (wsUrl) break; } catch (e) { } }
    if (!wsUrl) { console.error('Chrome 未就绪'); ch.kill(); process.exit(2); }
    const WebSocket = require('C:/Users/shizi/.workbuddy/binaries/node/workspace/node_modules/ws');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const waiting = new Map();
    ws.on('message', r => { let m; try { m = JSON.parse(r.toString()); } catch (e) { return; } if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
    const send = (me, pa, si) => new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa || {}, sessionId: si })); });
    const tab = await send('Target.createTarget', { url: 'about:blank' });
    const sid = (await send('Target.attachToTarget', { targetId: tab.result.targetId, flatten: true })).result.sessionId;
    await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid);
    const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }, sid); return r.result && r.result.result ? r.result.result.value : null; };
    const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sid); if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); };
    const typeText = async t => { await send('Input.insertText', { text: t }, sid); };
    const key = async (k, code, vk) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid); };
    const clickAt = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid); };
    const nav = async (url, wait) => { await send('Page.navigate', { url }, sid); await sleep(wait); };
    const visText = async () => (await ev(VT_FN)) || '';
    const page = async (name, hash, wait) => {
        await nav(BASE + '/' + hash, wait || 4200);
        await shot(name);
        const vt = await visText();
        const hits = scan(vt);
        report.pages.push({ name, hash: await ev('location.hash'), hits, text_len: vt.length });
        addCheck('词典断言·' + name, hits.length === 0, hits.length ? hits.join(' || ') : '0 命中');
        return { vt, hits };
    };

    try {
        // ===== 登录 =====
        await nav(BASE + '/#/login', 5500);
        await ev("(function(){var b=document.querySelector('#kc-guest [data-action=\"guest-login\"]');if(b)b.click();})()");
        await sleep(1600);
        const boxStr = await ev("(function(){var ins=document.querySelectorAll('#kc-gl-modal input');for(var i=0;i<ins.length;i++){if((ins[i].type||'')!=='password'){var r=ins[i].getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return null;})()");
        if (boxStr) { const b = JSON.parse(boxStr); await clickAt(b.x, b.y); await sleep(250); await typeText(EMAIL); await sleep(350); await key('Tab', 'Tab', 9); await sleep(250); await typeText(PASS); await sleep(400); }
        // 自建登录层为原生 <form>：Enter 需带 text 才会触发浏览器隐式提交（keypress）
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }, sid);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sid);
        let ok = false; for (let i = 0; i < 40; i++) { await sleep(500); if (await ev("localStorage.getItem('VUE_NAIVE_ACCESS_TOKEN')?1:0")) { ok = true; break; } }
        if (!ok) { await ev("(function(){var b=document.getElementById('kc-gl-submit');if(b)b.click();return 'ok';})()"); for (let i = 0; i < 24; i++) { await sleep(500); if (await ev("localStorage.getItem('VUE_NAIVE_ACCESS_TOKEN')?1:0")) { ok = true; break; } } }
        addCheck('登录测试账号', ok, EMAIL);
        if (!ok) throw new Error('登录失败');

        // ===== 1. 首页 =====
        await page('01_dashboard', '#/dashboard', 4500);

        // ===== 2. 商品页 =====
        await page('02_plan', '#/plan', 4500);

        // ===== 3. 订单列表（列头/值断言）=====
        await nav(BASE + '/#/order', 4500); await shot('03_order_list');
        const listDump = await ev("(function(){var ths=[];var th=document.querySelectorAll('th');for(var i=0;i<th.length;i++)ths.push(th[i].textContent.trim());var rows=[];var trs=document.querySelectorAll('tbody tr');for(var j=0;j<trs.length&&j<4;j++){var tds=trs[j].querySelectorAll('td');var row=[];for(var k=0;k<tds.length;k++)row.push(tds[k].textContent.trim().slice(0,20));rows.push(row);}return JSON.stringify({ths:ths,rows:rows});})()");
        const listJ = JSON.parse(listDump || '{}');
        report.pages.push({ name: '03_order_list_dump', dump: listJ });
        const ths = listJ.ths || [];
        addCheck('列表·列头含「服务周期」且无裸「周期」', ths.indexOf('服务周期') >= 0 && ths.indexOf('周期') < 0, JSON.stringify(ths));
        const listVT = await visText();
        addCheck('列表·词典断言（可见文本）', scan(listVT).length === 0, scan(listVT).join(' || ') || '0 命中');
        const rowVals = (listJ.rows || []).map(r => r.join(' ')).join(' | ');
        addCheck('列表·值已映射（无「月付/一次性」徽标）', rowVals.indexOf('月付') < 0 && rowVals.indexOf('一次性') < 0, rowVals.slice(0, 160));

        // ===== 4. 订单详情（动态取最近订单）=====
        const tradeNo = await ev("(function(){var raw=localStorage.getItem('VUE_NAIVE_ACCESS_TOKEN');var tok='';try{var o=JSON.parse(raw);tok=o&&o.value?o.value:'';}catch(e){tok=raw||'';}return fetch('/api/v1/user/order/fetch',{headers:{'Accept':'application/json','Authorization':'Bearer '+tok}}).then(function(r){return r.json();}).then(function(j){var d=(j&&j.data)||[];return (d[0]&&d[0].trade_no)||'';}).catch(function(){return '';});})()") || '';
        const detailNo = tradeNo || '2026101223101412675713254';
        await nav(BASE + '/#/order/' + detailNo, 4800); await shot('04_order_detail');
        const dDump = await ev("(function(){var out={rows:[],buttons:[]};var divs=document.querySelectorAll('div');for(var i=0;i<divs.length;i++){var d=divs[i];if(d.childElementCount===2){var lab=(d.children[0].textContent||'').trim();var val=(d.children[1].textContent||'').trim();if(lab.length<26&&lab.charAt(lab.length-1)==='：'&&val.length<70)out.rows.push(lab+' '+val);}}var bs=document.querySelectorAll('button, .n-button');for(var j=0;j<bs.length&&out.buttons.length<30;j++){var b=bs[j];if(b.offsetParent===null)continue;var tx=(b.textContent||'').trim();if(tx&&tx.length<20)out.buttons.push(tx);}return JSON.stringify(out);})()");
        const dJ = JSON.parse(dDump || '{}');
        report.pages.push({ name: '04_order_detail_dump', tradeNo: detailNo, dump: dJ });
        const rowsStr = (dJ.rows || []).join(' | ');
        // 期望值随「最近订单」的 period 变化（月付/一次性/权益包兑换等），故断言映射后落在合法值域
        addCheck('详情·「服务周期」替换到位（映射到合法值域）', /服务周期：\s*(单次|30 天|90 天|180 天|365 天|730 天|1095 天)/.test(rowsStr), rowsStr.slice(0, 200));
        addCheck('详情·「交付方式：卡密自动发放」替换到位', rowsStr.indexOf('交付方式') >= 0 && rowsStr.indexOf('卡密自动发放') >= 0, rowsStr.slice(0, 200));
        addCheck('详情·无「类型/周期」「产品流量」残留', rowsStr.indexOf('类型/周期') < 0 && rowsStr.indexOf('产品流量') < 0);
        addCheck('详情·无「查看使用教程」按钮', (dJ.buttons || []).indexOf('查看使用教程') < 0, (dJ.buttons || []).join(','));
        const dVT = await visText();
        const dHits = scan(dVT);
        report.pages.push({ name: '04_order_detail_visible', hits: dHits });
        addCheck('详情·词典断言（可见文本）', dHits.length === 0, dHits.join(' || ') || '0 命中');

        // ===== 5. 个人中心 =====
        await nav(BASE + '/#/profile', 4500); await shot('05_profile');
        const pDump = await ev("(function(){var out={cards:[]};var hs=document.querySelectorAll('.n-card-header__main');for(var i=0;i<hs.length;i++){if(hs[i].offsetParent===null)continue;var t=(hs[i].textContent||'').trim();if(t)out.cards.push(t);}return JSON.stringify(out);})()");
        const pJ = JSON.parse(pDump || '{}');
        report.pages.push({ name: '05_profile_dump', dump: pJ });
        addCheck('个人中心·无「重置订阅信息」卡', (pJ.cards || []).indexOf('重置订阅信息') < 0, (pJ.cards || []).join(','));
        addCheck('个人中心·无「通知」卡', (pJ.cards || []).indexOf('通知') < 0, (pJ.cards || []).join(','));
        const pVT = await visText();
        const pHits = scan(pVT);
        report.pages.push({ name: '05_profile_visible', hits: pHits });
        addCheck('个人中心·词典断言（可见文本）', pHits.length === 0, pHits.join(' || ') || '0 命中');

        // ===== 6. 头像菜单 =====
        await ev("(function(){var a=document.getElementById('kc-tb-avatar');if(a)a.click();})()");
        await sleep(900); await shot('06_avatar_menu');
        const menu = await ev("(function(){var m=document.querySelector('.kc-tb-menu');if(!m)return '';var it=[];var all=m.querySelectorAll('a,button');for(var i=0;i<all.length;i++)it.push((all[i].textContent||'').trim());return JSON.stringify(it);})()");
        const menuJ = JSON.parse(menu || '[]');
        report.pages.push({ name: '06_avatar_menu', items: menuJ });
        addCheck('菜单·无「节点状态/流量明细/使用文档」', ['节点状态', '流量明细', '使用文档'].every(x => menuJ.indexOf(x) < 0), menuJ.join(','));
        await ev("document.body.click()"); await sleep(300);

        // ===== 7. 路由拦截（直连刷新 + SPA 跳转）=====
        await nav(BASE + '/#/node', 1200); await send('Page.reload', {}, sid); await sleep(4500);
        const hNode = await ev('location.hash');
        await shot('07_node_redirect');
        addCheck('路由·#/node 直连刷新 → #/dashboard', hNode === '#/dashboard', 'hash=' + hNode);
        await nav(BASE + '/#/traffic', 3000); await sleep(1500);
        const hTraffic = await ev('location.hash');
        addCheck('路由·#/traffic SPA 跳转 → #/dashboard', hTraffic === '#/dashboard', 'hash=' + hTraffic);

        // ===== 8. 游客态（退出登录 → 落地页断言）=====
        await ev("try{localStorage.clear();}catch(e){}");
        await nav(BASE + '/#/login', 5500); await shot('08_guest_landing');
        const gVT = await visText();
        const gHits = scan(gVT);
        report.pages.push({ name: '08_guest_landing', hits: gHits });
        addCheck('游客落地·词典断言', gHits.length === 0, gHits.join(' || ') || '0 命中');
        const guestOk = await ev("!!document.getElementById('kc-guest')");
        addCheck('游客落地·品牌落地页挂载', !!guestOk);
    } catch (e) {
        report.errors.push('FATAL: ' + e.message);
        console.error('异常: ' + e.message);
    } finally {
        fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
        console.log('\n===== 汇总 =====');
        console.log('断言: ' + report.checks.filter(c => c.ok).length + ' PASS / ' + failCount + ' FAIL（共 ' + report.checks.length + '）');
        console.log('报告: ' + path.join(OUT, 'report.json'));
        try { ws.close(); } catch (e) { }
        try { ch.kill(); } catch (e) { }
        await sleep(800);
    }
    process.exit(report.errors.length ? 2 : (failCount ? 1 : 0));
})().catch(e => { console.error('外层异常:', e.message); process.exit(2); });
