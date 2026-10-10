<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>代充运营菜单</title>
    <style>
        body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:#f8fafc;color:#0f172a;margin:0}
        .wrap{max-width:1180px;margin:0 auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}
        .muted{color:#64748b;font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
        .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;box-shadow:0 8px 24px #0f172a0a}.card h3{margin:0 0 8px;font-size:16px}
        .card a{display:block;color:#2563eb;text-decoration:none;padding:8px 0;border-bottom:1px solid #f1f5f9}.card a:last-child{border-bottom:0}
        .btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:8px 12px;cursor:pointer}.btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
        .table{width:100%;border-collapse:collapse;font-size:12px}.table th,.table td{padding:9px 7px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}.table th{background:#f8fafc}
        .status{padding:3px 7px;border-radius:999px;background:#fef3c7;color:#92400e}.status.done{background:#dcfce7;color:#166534}
        .danger{color:#b91c1c}.form{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:12px}.form input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:7px}.form .wide{grid-column:span 2}
        @media(max-width:760px){.form{grid-template-columns:1fr}.form .wide{grid-column:auto}.wrap{padding:16px}}
    </style>
</head>
<body>
<main class="wrap">
    <header class="top">
        <div><h1 style="margin:0 0 5px">代充运营后台</h1><div class="muted">Xboard 运营菜单 · KC 与 Xboard 保持独立认证 · Zovo 仍为 Mock</div></div>
        <a href="/{{ $securePath }}/" class="btn">返回 Xboard 首页</a>
    </header>

    <section class="grid">
        <div class="card"><h3>商品与订单</h3><a href="/{{ $securePath }}/#/finance/plan">代充商品</a><a href="/{{ $securePath }}/#/finance/order">订单管理</a><a href="/{{ $securePath }}/#/user/manage">用户与余额</a></div>
        <div class="card"><h3>支付与售后</h3><a href="/{{ $securePath }}/#/payment">USDT 支付配置</a>@if(!empty($walletUrl))<a href="{{ $walletUrl }}" target="_blank" rel="noopener">打开 BEpusdt 钱包后台 ↗</a>@else<span class="muted" style="display:block;padding:8px 0">未配置钱包后台地址</span>@endif<a href="/{{ $securePath }}/#/user/ticket">售后工单</a><a href="/{{ $securePath }}/#/system">系统状态（管理员）</a></div>
        <div class="card"><h3>暂不使用</h3><div class="muted">优惠券、分销、礼品卡、主题、邮件、节点、流量等菜单已从运营入口移除，底层数据未删除。</div></div>
    </section>

    <section class="card" id="topups" style="margin-top:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><div><h3>充值异常 / 余额补单</h3><div class="muted">只处理已核验的钱包到账；少付、错链、重复交易保持人工审核。当前 BEpusdt 未配置可用的只读订单查询接口，不能仅凭“钱包到账”自动入账。</div></div><button class="btn" id="refresh">刷新</button></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0"><input id="search" placeholder="订单号 / 支付参考号" style="padding:8px;border:1px solid #cbd5e1;border-radius:7px"><button class="btn primary" id="load">查询</button></div>
        <div style="overflow:auto"><table class="table"><thead><tr><th>订单</th><th>用户</th><th>应付/实收</th><th>匹配状态</th><th>交易哈希</th><th>操作</th></tr></thead><tbody id="rows"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody></table></div>
    </section>

    <section class="card" style="margin-top:18px"><h3>人工补单</h3><div class="muted">必须填写交易哈希、已核验的网关计价金额（最小单位）和原因；补单会复用充值幂等与账务流水，不允许直接改余额。</div>
        <div class="form"><input id="trade" placeholder="订单号"><input id="tx" class="wide" placeholder="TRC20 交易哈希"><input id="received" type="number" min="1" placeholder="实收金额（最小单位）"><input id="confirmations" type="number" min="0" value="20" placeholder="确认数"><input id="reason" class="wide" placeholder="补单原因（至少4字）"><button class="btn primary" id="credit">确认到账并补单</button></div>
        <div id="msg" class="muted" style="margin-top:10px"></div>
    </section>
    <p class="muted" style="margin-top:18px">技术维护入口仍可通过原 Xboard 菜单访问；本页面只提供代充运营入口，未删除底层路由。</p>
</main>
<script>
const api=(path,opt={})=>fetch(path,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok||d.code<0)throw new Error(d.message||'请求失败');return d});
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
async function load(){const q=encodeURIComponent(document.getElementById('search').value.trim());const d=await api('/admin/kc/topups?trade_no='+q);const rows=d.data?.orders||d.orders||[];document.getElementById('rows').innerHTML=rows.length?rows.map(r=>`<tr><td>${esc(r.trade_no)}<br><span class="muted">${esc(r.payment_reference||'')}</span></td><td>${esc(r.user_email||r.user_id)}</td><td>${Number(r.expected_amount||0)} / ${Number(r.received_amount||0)}</td><td><span class="status ${r.status==='done'?'done':''}">${esc(r.match_status||r.status)}</span></td><td style="max-width:180px;word-break:break-all">${esc(r.tx_hash||'—')}</td><td><button class="btn" onclick="pick('${esc(r.trade_no)}','${esc(r.tx_hash||'')}','${Number(r.received_amount||0)}')">带入补单</button> <button class="btn" onclick="review('${esc(r.trade_no)}')">标记异常</button></td></tr>`).join(''):'<tr><td colspan="6" class="muted">暂无记录</td></tr>'}
function pick(t,x,a){document.getElementById('trade').value=t;document.getElementById('tx').value=x;document.getElementById('received').value=a||'';document.getElementById('reason').focus()}
async function review(t){const reason=window.prompt('请输入异常原因（至少4字）','等待核验钱包到账');if(!reason)return;const msg=document.getElementById('msg');msg.textContent='标记中…';try{await api('/admin/kc/topups/mark-review',{method:'POST',body:JSON.stringify({trade_no:t,reason})});msg.textContent='已进入人工复核队列';await load()}catch(e){msg.textContent=e.message}}
document.getElementById('load').onclick=()=>load().catch(e=>document.getElementById('msg').textContent=e.message);document.getElementById('refresh').onclick=()=>load().catch(e=>document.getElementById('msg').textContent=e.message);
document.getElementById('credit').onclick=async()=>{const msg=document.getElementById('msg');msg.textContent='提交中…';try{const d=await api('/admin/kc/topups/credit',{method:'POST',body:JSON.stringify({trade_no:document.getElementById('trade').value,tx_hash:document.getElementById('tx').value,received_amount:Number(document.getElementById('received').value),confirmations:Number(document.getElementById('confirmations').value),reason:document.getElementById('reason').value})});msg.textContent='补单完成：'+(d.data?.status||'credited');await load()}catch(e){msg.textContent=e.message}};
load().catch(e=>document.getElementById('rows').innerHTML='<tr><td colspan="6" class="danger">'+esc(e.message)+'</td></tr>');
</script>
</body>
</html>
