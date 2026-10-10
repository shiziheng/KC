<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>客服工作台</title>
    <style>
        body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:#f8fafc;color:#0f172a;margin:0}
        .wrap{max-width:1180px;margin:0 auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap}
        .muted{color:#64748b;font-size:13px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;box-shadow:0 8px 24px #0f172a0a;margin-top:16px}
        .card h3{margin:0 0 10px;font-size:15px}
        .search{display:flex;gap:8px;flex-wrap:wrap}.search input{flex:1;min-width:260px;padding:10px;border:1px solid #cbd5e1;border-radius:8px}
        .btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;text-decoration:none;color:#0f172a;font-size:13px;display:inline-block}
        .btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
        table.list{width:100%;border-collapse:collapse;font-size:12.5px}.list th,.list td{padding:8px 7px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}
        .list th{background:#f8fafc}.chip{display:inline-block;padding:2px 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:12px}
        .chip.ok{background:#dcfce7;color:#166534}.chip.warn{background:#fef3c7;color:#92400e}.chip.bad{background:#fee2e2;color:#991b1b}
        .kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px 18px;font-size:13px}.kv div{line-height:1.7}
        .mono{font-family:ui-monospace,Consolas,monospace;word-break:break-all}
        .talk{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.talk .card{margin-top:0}
        pre.tpl{white-space:pre-wrap;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:10px;font-size:12.5px;line-height:1.75;margin:8px 0 10px;font-family:inherit}
        .bad{color:#b91c1c}.row-actions{display:flex;gap:8px;flex-wrap:wrap}
        .next{background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.8}
        @media(max-width:760px){.wrap{padding:16px}}
    </style>
</head>
<body>
<main class="wrap">
    <header class="top">
        <div><h1 style="margin:0 0 5px">客服工作台</h1><div class="muted">只读聚合查询 · 金额以美元（$）展示 · 客服不索取账号密码 / Session</div></div>
        <div class="row-actions">
            <a href="/plugins/kc_integration/ops" class="btn">运营壳</a>
            <a href="/{{ $securePath }}/" class="btn">Xboard 首页</a>
        </div>
    </header>

    <section class="card">
        <h3>查询</h3>
        <div class="search">
            <input id="q" placeholder="用户邮箱 / 用户ID / 订单号（自动识别；订单号为 25 位长数字）">
            <button class="btn primary" id="go">查询</button>
        </div>
        <div id="hint" class="muted" style="margin-top:8px">一次输入即可：邮箱查用户全景（余额 / 订单 / 充值 / 卡密 / 售后），长数字订单号查订单进度（含 KC 实时复核）。</div>
    </section>

    <div id="result"></div>

    <section class="card" id="talk">
        <h3>标准话术卡（点击复制按钮复制全文）</h3>
        <div class="talk" id="talkWrap"></div>
    </section>

    <p class="muted" style="margin-top:18px">数据来源：订单 / 充值台账 / 发卡记录 / 售后与补偿（只读）＋ KC 实时任务状态（复核用）。补单与退款请走既有审核流程，本页不提供任何写操作。</p>
</main>
<script>
const kcTok = () => { try { const r = localStorage.getItem('VUE_NAIVE_ACCESS_TOKEN'); if (!r) return ''; const j = JSON.parse(r); return (j && typeof j === 'object' && j.value) ? String(j.value) : (String(r).length < 400 ? String(r) : ''); } catch (e) { return ''; } };
const api = (p) => { const t = kcTok(); return fetch(p, { credentials: 'same-origin', headers: t ? { 'Accept': 'application/json', 'Authorization': 'Bearer ' + t } : { 'Accept': 'application/json' } })
    .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok || d.success === false) throw new Error(d.message || ('HTTP ' + r.status)); return d.data !== undefined ? d.data : d; }); };
(function banner() { if (!kcTok()) { const d = document.createElement('div'); d.className = 'muted'; d.style.cssText = 'margin:0 0 12px;color:#b45309'; d.textContent = '未检测到管理端登录态：请先在管理端登录，再刷新本页（查询接口需管理员身份）。'; const m = document.querySelector('main'); if (m) m.prepend(d); } })();
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const usd = (fen) => '$' + (Number(fen || 0) / 100).toFixed(2);
const ts = (t) => { if (!t) return '—'; const d = new Date(typeof t === 'number' ? t * 1000 : Date.parse(String(t).replace(' ', 'T'))); if (isNaN(d)) return esc(t); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
const chip = (txt, cls) => '<span class="chip ' + (cls || '') + '">' + esc(txt) + '</span>';

function orderChip(s) { return s === 3 ? chip(s + ' 已完成', 'ok') : (s === 0 ? chip(s + ' 待支付', 'warn') : chip(s)); }
function cardLine(c) {
    if (!c) return '<span class="muted">无发卡记录</span>';
    var st = c.status === 'issued' ? chip('已发卡', 'ok') : chip(c.status || '-', c.status === 'failed' ? 'bad' : 'warn');
    var kc = c.kc_status ? chip('KC: ' + c.kc_status, c.kc_status === 'completed' ? 'ok' : (c.kc_status === 'failed' ? 'bad' : '')) : '';
    return st + ' ' + kc;
}

function renderUser(d) {
    if (!d.found) return '<section class="card"><div>未找到该用户：<b>' + esc(d.query) + '</b>（可尝试完整邮箱或工单里的用户ID）</div></section>';
    var u = d.user, h = [];
    h.push('<section class="card"><h3>用户 · ' + esc(u.email) + '</h3><div class="kv">');
    h.push('<div><b>用户ID</b>：' + u.id + '</div>');
    h.push('<div><b>余额</b>：<b>' + usd(u.balance) + '</b></div>');
    h.push('<div><b>状态</b>：' + (u.banned ? chip('已封禁', 'bad') : chip('正常', 'ok')) + '</div>');
    h.push('<div><b>注册时间</b>：' + ts(u.created_at) + '</div>');
    h.push('<div><b>上次登录</b>：' + ts(u.last_login_at) + '</div>');
    h.push('<div><b>当前订阅</b>：' + (u.plan_id ? ('套餐ID ' + u.plan_id + (u.expired_at ? ' · 到期 ' + ts(u.expired_at) : '')) : '无') + '</div>');
    h.push('</div></section>');

    h.push('<section class="card"><h3>最近订单（10 条）</h3><table class="list"><thead><tr><th>订单号</th><th>套餐</th><th>金额</th><th>状态</th><th>创建</th><th>卡密 / 开通</th></tr></thead><tbody>');
    h.push(d.orders.length ? d.orders.map(function (o) {
        return '<tr><td class="mono">' + esc(o.trade_no) + '</td><td>' + esc(o.plan_name || ('#' + o.plan_id)) + '</td><td>' + usd(o.total_amount) + (o.balance_amount ? '<br><span class="muted">余额抵扣 ' + usd(o.balance_amount) + '</span>' : '') + '</td><td>' + orderChip(o.status) + '</td><td>' + ts(o.created_at) + '</td><td>' + (o.card_status ? cardLine({ status: o.card_status, kc_status: o.kc_status }) : '<span class="muted">—</span>') + (o.kc_progress != null ? '<br><span class="muted">进度 ' + o.kc_progress + '%</span>' : '') + (o.kc_message ? '<br><span class="muted">' + esc(o.kc_message) + '</span>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">无</td></tr>');
    h.push('</tbody></table></section>');

    h.push('<section class="card"><h3>充值记录（10 条）</h3><table class="list"><thead><tr><th>订单号</th><th>金额</th><th>状态</th><th>应付</th><th>实收</th><th>到账后余额</th><th>创建</th></tr></thead><tbody>');
    h.push(d.topups.length ? d.topups.map(function (t) {
        var cls = t.status === 'done' ? 'ok' : (t.status === 'failed' ? 'bad' : 'warn');
        return '<tr><td class="mono">' + esc(t.trade_no) + '</td><td>' + usd(t.amount) + '</td><td>' + chip(t.status_cn || t.status, cls) + '</td><td>' + usd(t.expected_amount) + '</td><td>' + usd(t.received_amount) + '</td><td>' + usd(t.balance_after) + '</td><td>' + ts(t.created_at) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">无</td></tr>');
    h.push('</tbody></table></section>');

    h.push('<section class="card"><h3>卡密记录（10 条）</h3><table class="list"><thead><tr><th>订单号</th><th>档位</th><th>状态</th><th>卡密</th><th>更新时间</th></tr></thead><tbody>');
    h.push(d.cards.length ? d.cards.map(function (c) {
        return '<tr><td class="mono">' + esc(c.trade_no) + '</td><td>' + esc(c.plan_type) + '</td><td>' + cardLine(c) + (c.kc_message ? '<br><span class="muted">' + esc(c.kc_message) + '</span>' : '') + '</td><td class="mono">' + esc(c.cdk_code) + '</td><td>' + ts(c.updated_at) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="muted">无</td></tr>');
    h.push('</tbody></table></section>');

    if (d.after_sales && d.after_sales.length) {
        h.push('<section class="card"><h3>售后工单</h3><table class="list"><thead><tr><th>工单号</th><th>订单号</th><th>类型</th><th>状态</th><th>创建</th></tr></thead><tbody>');
        h.push(d.after_sales.map(function (a) { return '<tr><td class="mono">' + esc(a.request_no) + '</td><td class="mono">' + esc(a.trade_no) + '</td><td>' + esc(a.request_type) + '</td><td>' + chip(a.status) + '</td><td>' + ts(a.created_at) + '</td></tr>'; }).join(''));
        h.push('</tbody></table></section>');
    }
    if (d.compensations && d.compensations.length) {
        h.push('<section class="card"><h3>补偿记录</h3><table class="list"><thead><tr><th>订单号</th><th>类型</th><th>状态</th><th>金额</th><th>创建</th></tr></thead><tbody>');
        h.push(d.compensations.map(function (c) { return '<tr><td class="mono">' + esc(c.trade_no) + '</td><td>' + esc(c.compensation_type) + '</td><td>' + chip(c.status) + '</td><td>' + usd(c.amount) + '</td><td>' + ts(c.created_at) + '</td></tr>'; }).join(''));
        h.push('</tbody></table></section>');
    }
    return h.join('');
}

function renderOrder(d) {
    if (!d.found) return '<section class="card"><div>未找到该订单：<b class="mono">' + esc(d.trade_no) + '</b></div></section>';
    var o = d.order, h = [];
    h.push('<section class="card"><h3>订单 · <span class="mono">' + esc(o.trade_no) + '</span></h3><div class="kv">');
    h.push('<div><b>用户</b>：' + esc(o.user_email || ('ID ' + o.user_id)) + '</div>');
    h.push('<div><b>套餐</b>：' + esc(o.plan_name || ('#' + o.plan_id)) + '</div>');
    h.push('<div><b>金额</b>：' + usd(o.total_amount) + (o.balance_amount ? '（余额抵扣 ' + usd(o.balance_amount) + '）' : '') + '</div>');
    h.push('<div><b>状态</b>：' + orderChip(o.status) + '</div>');
    h.push('<div><b>创建</b>：' + ts(o.created_at) + '</div>');
    h.push('<div><b>支付时间</b>：' + ts(o.paid_at) + '</div>');
    h.push('</div></section>');

    h.push('<section class="card"><h3>卡密 / 开通</h3>');
    if (d.card) {
        h.push('<div class="kv"><div><b>发卡状态</b>：' + cardLine(d.card) + '</div><div><b>尝试次数</b>：' + d.card.attempts + '</div><div><b>更新时间</b>：' + ts(d.card.updated_at) + '</div></div>');
        if (d.card.kc_progress != null) h.push('<div class="muted" style="margin-top:6px">进度：' + d.card.kc_progress + '%</div>');
        if (d.card.kc_message) h.push('<div class="muted" style="margin-top:4px">状态说明：' + esc(d.card.kc_message) + '</div>');
        if (d.card.error_msg) h.push('<div class="bad" style="margin-top:4px">异常信息：' + esc(d.card.error_msg) + '</div>');
        h.push('<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="mono" style="font-size:16px;font-weight:700" id="cdk">' + esc(d.card.cdk_code) + '</span><button class="btn" onclick="copyEl(\'cdk\',this)">复制卡密</button></div>');
    } else {
        h.push('<div class="muted">该订单暂无发卡记录（可能为人工交付、未映射套餐或尚未履约）。</div>');
    }
    h.push('</section>');

    h.push('<section class="card"><h3>KC 实时复核</h3>');
    if (d.live && d.live.tried && d.live.ok) {
        h.push('<div class="kv"><div><b>卡密状态</b>：' + esc(d.live.cdk_state || '-') + ' ' + (d.live.status_cn ? chip(d.live.status_cn) : '') + '</div><div><b>任务状态</b>：' + esc(d.live.task_status || '-') + '</div><div><b>进度</b>：' + (d.live.progress != null ? d.live.progress + '%' : '—') + '</div></div>');
        if (d.live.message) h.push('<div class="muted" style="margin-top:6px">' + esc(d.live.message) + '</div>');
    } else {
        h.push('<div class="muted">未取到实时结果：' + esc((d.live && d.live.error) || '未知原因') + '（以本地记录为准）</div>');
    }
    h.push('</section>');

    if (d.topup) {
        var t = d.topup;
        h.push('<section class="card"><h3>充值记录</h3><div class="kv"><div><b>状态</b>：' + chip(t.status_cn || t.status, t.status === 'done' ? 'ok' : 'warn') + '</div><div><b>金额</b>：' + usd(t.amount) + '</div><div><b>应付</b>：' + usd(t.expected_amount) + '</div><div><b>实收</b>：' + usd(t.received_amount) + '</div><div><b>到账后余额</b>：' + usd(t.balance_after) + '</div><div><b>创建</b>：' + ts(t.created_at) + '</div></div></section>');
    }

    h.push('<section class="card"><h3>建议处理</h3><div class="next">' + esc(nextStepText(d)).split('\n').join('<br>') + '</div></section>');
    return h.join('');
}

function nextStepText(d) {
    var o = d.order, lines = [];
    if (o.status === 0) lines.push('订单待支付：提醒用户按收银台金额（含尾数）与地址完成转账。');
    if (d.topup && d.topup.status === 'pending') lines.push('充值未到账：请用户提供链上 TXID；核实后在运营壳「人工补单」处理（禁止直接改余额）。');
    if (d.topup && d.topup.status === 'done') lines.push('充值已到账：余额 ' + usd(d.topup.balance_after) + '，可提示用户刷新查看。');
    if (d.card && d.card.status === 'issued' && ['pending', 'running'].indexOf(String(d.card.kc_status)) >= 0) lines.push('开通处理中：属正常状态，建议用户稍后刷新订单页；超过较长时间可转人工复核。');
    if (d.live && d.live.ok && ['completed', 'used'].indexOf(String(d.live.cdk_state)) >= 0) lines.push('KC 复核：已开通完成，可引导用户到 ChatGPT 查看订阅。');
    if (d.live && d.live.ok && ['failed', 'expired', 'frozen', 'manual', 'not_found'].indexOf(String(d.live.cdk_state)) >= 0) lines.push('KC 复核异常：引导用户走售后/补偿流程（工单已自动入队时无需重复提交）。');
    if (!d.card && o.status === 3) lines.push('已支付但无发卡记录：检查套餐映射 / 人工交付标记。');
    if (!lines.length) lines.push('暂无特别提示。');
    return lines.join('\n');
}

function copyEl(id, btn) {
    var el = document.getElementById(id); if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(function () { var b = btn.textContent; btn.textContent = '已复制'; setTimeout(function () { btn.textContent = b; }, 1200); });
}
function copyTpl(idx, btn) {
    var el = document.querySelectorAll('pre.tpl')[idx]; if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(function () { var b = btn.textContent; btn.textContent = '已复制'; setTimeout(function () { btn.textContent = b; }, 1200); });
}

var TALK = [
    ['Session 获取指引（发送给用户）', '您好，开通需要您在电脑浏览器完成这一步（约 1 分钟）：\n1. 打开并登录目标 ChatGPT 账号（chatgpt.com）\n2. 新标签页打开：chatgpt.com/api/auth/session（会显示一段 JSON 文本）\n3. 全选（Ctrl+A）→ 复制（Ctrl+C）\n4. 回到订单页点「去开通」，把内容粘贴到输入框提交即可\n\n安全提醒：Session 属于账号凭据，请勿发给任何人（包括客服）；如提示失败，通常是未登录或复制不完整，重试即可。'],
    ['充值未到账（核查与引导）', '您好，请提供充值订单号（或注册邮箱），我来帮您核查：\n· 已支付未到账：请提供链上交易哈希（TXID），我们核对金额与到账情况后按流程补单；\n· 未支付：请按收银台显示的金额与地址完成转账（网络选择 TRC20）；\n· 少付 / 错链：需要人工复核，处理时间稍长，请耐心等待。\n\n金额均以美元计价，到账后余额自动更新。'],
    ['卡密与兑换', '您好，卡密在「我的订单 → 订单详情」查看。\n· 兑换方式：打开兑卡页 → 粘贴卡密 → 提交目标账号 Session → 系统自动开通；\n· 卡密或兑换遇到问题：把订单号发我，我帮您核查卡密状态；\n· 规则说明：卡密售出后不支持退款，未兑换前可自行转赠。'],
    ['服务边界（对内规范）', '· 不向用户索取：账号密码、Session、短信验证码、支付密钥；\n· 不承诺具体开通时效；失败按补偿 / 售后流程处理；\n· 人工补单必须：订单号 + TXID + 已核验金额，走运营壳「人工补单」（禁止直接改余额）；\n· 涉及退款：引导用户提交售后工单，客服不直接退款。'],
];

(function initTalk() {
    var wrap = document.getElementById('talkWrap');
    wrap.innerHTML = TALK.map(function (t, i) {
        return '<div class="card"><h3 style="font-size:14px">' + esc(t[0]) + '</h3><pre class="tpl" data-i="' + i + '">' + esc(t[1]) + '</pre><button class="btn" onclick="copyTpl(' + i + ',this)">复制</button></div>';
    }).join('');
})();

(function bind() {
    var input = document.getElementById('q'), btn = document.getElementById('go'), box = document.getElementById('result');
    function run() {
        var q = input.value.trim();
        if (!q) { box.innerHTML = ''; return; }
        box.innerHTML = '<section class="card"><div class="muted">查询中…</div></section>';
        var isOrder = /^\d{16,}$/.test(q);
        var req = isOrder ? api('/admin/kc/support/order?trade_no=' + encodeURIComponent(q)) : api('/admin/kc/support/user?q=' + encodeURIComponent(q));
        req.then(function (d) {
            if (isOrder) { box.innerHTML = renderOrder(d); }
            else {
                if (d.found) { box.innerHTML = renderUser(d); }
                else if (/^\d+$/.test(q)) {
                    api('/admin/kc/support/order?trade_no=' + encodeURIComponent(q)).then(function (od) {
                        box.innerHTML = od.found ? renderOrder(od) : renderUser(d);
                    }).catch(function (e) { box.innerHTML = '<section class="card"><div class="bad">' + esc(e.message) + '</div></section>'; });
                } else { box.innerHTML = renderUser(d); }
            }
        }).catch(function (e) { box.innerHTML = '<section class="card"><div class="bad">' + esc(e.message) + '</div></section>'; });
    }
    btn.onclick = run;
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
})();
</script>
</body>
</html>
