<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{ $title }}</title>
  <script>
    window.settings = {
      base_url: "/",
      title: "{{ $title }}",
      version: "{{ $version }}",
      logo: "{{ $logo }}",
      secure_path: "{{ $secure_path }}",
    };
  </script>
  @php
    $manifestPath = public_path('assets/admin/manifest.json');
    $manifest = file_exists($manifestPath) ? json_decode(file_get_contents($manifestPath), true) : null;
    $entry = is_array($manifest) ? ($manifest['index.html'] ?? null) : null;
    $scripts = [];
    $styles = [];
    $locales = [];

    if (is_array($entry)) {
      $visited = [];
      $collectAssets = function ($chunkName) use (&$collectAssets, &$manifest, &$visited, &$scripts, &$styles) {
        if (isset($visited[$chunkName]) || !isset($manifest[$chunkName]) || !is_array($manifest[$chunkName])) {
          return;
        }

        $visited[$chunkName] = true;
        $chunk = $manifest[$chunkName];

        if (!empty($chunk['css']) && is_array($chunk['css'])) {
          foreach ($chunk['css'] as $cssFile) {
            $styles[$cssFile] = $cssFile;
          }
        }

        if (!empty($chunk['imports']) && is_array($chunk['imports'])) {
          foreach ($chunk['imports'] as $import) {
            $collectAssets($import);
          }
        }

        if (!empty($chunk['isEntry']) && !empty($chunk['file'])) {
          $scripts[$chunk['file']] = $chunk['file'];
        }
      };

      $collectAssets('index.html');
    }

    foreach (glob(public_path('assets/admin/locales/*.js')) ?: [] as $localeFile) {
      $locales[] = 'locales/' . basename($localeFile);
    }
    sort($locales);
  @endphp

  @if($entry && count($scripts) > 0)
    @foreach($styles as $css)
      <link rel="stylesheet" crossorigin href="/assets/admin/{{ $css }}" />
    @endforeach
    @foreach($locales as $locale)
      <script src="/assets/admin/{{ $locale }}"></script>
    @endforeach
    @foreach($scripts as $js)
      <script type="module" crossorigin src="/assets/admin/{{ $js }}"></script>
    @endforeach
  @else
    {{-- Fallback: hardcoded paths for backward compatibility --}}
    <script type="module" crossorigin src="/assets/admin/assets/index.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/admin/assets/index.css" />
    <link rel="stylesheet" crossorigin href="/assets/admin/assets/vendor.css">
    <script src="/assets/admin/locales/en-US.js"></script>
    <script src="/assets/admin/locales/zh-CN.js"></script>
    <script src="/assets/admin/locales/ko-KR.js"></script>
  @endif
  <script>
    // ============================================================
    // KC 代充运营 · Xboard 管理端代充化过滤器 v2（KC-ADMIN-V2）
    // ------------------------------------------------------------
    // Xboard 管理端前端是编译产物，本脚本在「同源壳层」运行时处理：
    //   ① i18n 覆盖：主模块执行前改写 window.XBOARD_TRANSLATIONS
    //   ② 菜单收敛：路径黑/白名单 + 空组整组隐藏
    //   ③ 字段过滤：表格列 / 表单行 / 仪表盘卡片 / 弹窗区块 / 行操作菜单
    //   ④ 文案兜底：品牌（Xboard → KC 直供）、货币（¥ → $）
    // 工程约束：只隐藏（display:none）不删除节点；幂等 + 心跳自愈。
    // 底层路由与数据保留，技术管理员仍可直接访问原地址。
    // ============================================================
    (function () {
      'use strict';
      var MARK = 'KC-ADMIN-V2';
      if (window[MARK]) { return; }
      window[MARK] = 1;

      // ---------- ① i18n 覆盖（必须早于主模块 module 执行） ----------
      var I18N = {
        'sidebar.subscriptionManagement': '商品管理',
        'nav.subscriptionManagement': '商品管理',
        'settings.description': '管理系统核心配置——站点、安全、邀请佣金、邮件与通知等设置',
        'subscribe.plan.title': '商品套餐',
        'subscribe.plan.page.description': '在这里可以配置商品与价格，包括添加、删除、编辑等操作。',
        'subscribe.plan.columns.price_period.onetime': '充值包',
        'subscribe.plan.columns.price_period.reset_traffic': '重置包',
        'subscribe.plan.form.price.onetime_desc': '一次性价格，适合充值 / 单次类商品',
        'subscribe.plan.form.content.template.content': '## 商品说明\n• 官方渠道直充，支付成功后自动发放卡密\n• 卡密在订单详情中查看，自行前往官方渠道兑换\n\n## 使用流程\n1. 选择商品并完成支付\n2. 系统自动发放卡密（订单详情可见）\n3. 复制卡密前往官方渠道兑换\n\n## 注意事项\n- 虚拟商品，一经售出不支持退款\n- 下单前请仔细核对商品信息',
        'user.columns.subscription': '当前商品',
        'user.edit.form.subscription': '当前商品',
        'user.filter.fields.plan_id': '商品',
        'user.dialog.fields.subscriptionPlan': '当前商品',
        'order.table.columns.plan': '商品名称',
        'order.table.columns.period': '服务周期',
        'order.period.month_price': '30 天',
        'order.period.quarter_price': '90 天',
        'order.period.half_year_price': '180 天',
        'order.period.year_price': '365 天',
        'order.period.two_year_price': '730 天',
        'order.period.three_year_price': '1095 天',
        'order.period.onetime_price': '单次',
        'order.period.reset_price': '充值包',
        'order.dialog.fields.subscriptionPlan': '商品名称',
        'order.dialog.fields.orderPeriod': '服务周期',
        'order.dialog.placeholders.plan': '请选择商品',
        'payment.description': '在这里可以配置支付方式（USDT / EPay 等）。',
        'settings.email.remind_mail.description': '开启后将在账户需要提醒时向用户发送邮件通知。',
        'subscribe.plan.columns.price_period.unit.month': '/月',
        'subscribe.plan.columns.price_period.unit.quarter': '/季',
        'subscribe.plan.columns.price_period.unit.half_year': '/半年',
        'subscribe.plan.columns.price_period.unit.year': '/年',
        'subscribe.plan.columns.price_period.unit.two_year': '/两年',
        'subscribe.plan.columns.price_period.unit.three_year': '/三年',
        'subscribe.plan.columns.price_period.unit.times': '/次',
        'settings.subscribe.plan.columns.price_period.unit.month': '/月',
        'settings.subscribe.plan.columns.price_period.unit.quarter': '/季',
        'settings.subscribe.plan.columns.price_period.unit.half_year': '/半年',
        'settings.subscribe.plan.columns.price_period.unit.year': '/年',
        'settings.subscribe.plan.columns.price_period.unit.two_year': '/两年',
        'settings.subscribe.plan.columns.price_period.unit.three_year': '/三年',
        'settings.subscribe.plan.columns.price_period.unit.times': '/次',
        'settings.invite.commission_withdraw_limit.title': '提现单申请门槛($)'
      };
      try {
        var TR = window.XBOARD_TRANSLATIONS || (window.XBOARD_TRANSLATIONS = {});
        var zh = TR['zh-CN'] || (TR['zh-CN'] = {});
        Object.keys(I18N).forEach(function (path) {
          var segs = path.split('.');
          var cur = zh;
          for (var i = 0; i < segs.length - 1; i++) {
            var k = segs[i];
            if (typeof cur[k] !== 'object' || cur[k] === null) { cur[k] = {}; }
            cur = cur[k];
          }
          cur[segs[segs.length - 1]] = I18N[path];
        });
      } catch (e) { /* 覆盖失败不影响页面 */ }

      // ---------- ② 规则表 ----------
      var MENU_KEEP = ['/finance/plan', '/finance/order', '/user/manage', '/user/ticket', '/payment', '/config/notice'];
      var MENU_HIDE = ['/finance/coupon', '/finance/gift-card', '/server', '/traffic-reset', '/theme', '/mail/template', '/config/knowledge', '/config/plugin'];
      var HIDE_GROUPS = ['节点管理'];
      var HIDE_COLUMNS = ['权限组', '在线设备', '已用流量', '总流量', '下次重置时间', '到期时间'];
      var HIDE_LABELS = ['流量', '速度限制', '设备限制', '容量限制', '流量重置方式', '重置包', '服务器分组',
        '订阅设置', '节点配置', '订阅模板', '订阅URL', '订阅链接', '折抵金额', '注册试用', '两年付', '三年付', '提现单申请门槛($)'];
      var HIDE_CARDS = ['月上传', '月下载', '节点流量排行', '用户流量排行'];
      var HIDE_SECTIONS = ['订阅信息', '流量信息'];
      var HIDE_MENU_ITEMS = ['复制订阅URL', '重置UUID及订阅URL', '重置流量', 'TA的流量记录'];
      var LABEL_SET = Object.create(null);
      HIDE_LABELS.forEach(function (x) { LABEL_SET[x] = 1; });
      var CARD_SET = Object.create(null);
      HIDE_CARDS.forEach(function (x) { CARD_SET[x] = 1; });
      var SECTION_SET = Object.create(null);
      HIDE_SECTIONS.forEach(function (x) { SECTION_SET[x] = 1; });
      var MENUITEM_SET = Object.create(null);
      HIDE_MENU_ITEMS.forEach(function (x) { MENUITEM_SET[x] = 1; });

      // ---------- ③ 工具 ----------
      function txt(el) { return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim(); }
      function clsOf(el) { return (el && el.getAttribute && el.getAttribute('class')) || ''; }
      function isHidden(el) { return !!(el && el.style && el.style.display === 'none'); }
      function hide(el) { if (el && el.style && el.style.display !== 'none') { el.style.display = 'none'; return true; } return false; }
      function upTo(el, test, maxDepth) {
        var cur = el, d = 0;
        while (cur && d < (maxDepth || 6)) {
          if (test(cur)) { return cur; }
          cur = cur.parentElement; d++;
        }
        return null;
      }
      var isRounded = function (el) { return clsOf(el).indexOf('rounded') >= 0; };
      var isSpaceY = function (el) { return clsOf(el).indexOf('space-y') >= 0; };

      // 菜单：路径黑名单隐藏 + 分组整组隐藏
      function cleanMenu() {
        var nav = document.querySelector('nav');
        if (!nav) { return; }
        var links = nav.querySelectorAll('a[href],button[data-href]');
        for (var i = 0; i < links.length; i++) {
          var node = links[i];
          if (isHidden(node)) { continue; }
          var href = node.getAttribute('href') || node.getAttribute('data-href') || '';
          if (!href) { continue; }
          var keepHit = false;
          for (var a = 0; a < MENU_KEEP.length; a++) { if (href.indexOf(MENU_KEEP[a]) >= 0) { keepHit = true; break; } }
          if (keepHit) { continue; }
          var hideHit = false;
          for (var b = 0; b < MENU_HIDE.length; b++) { if (href.indexOf(MENU_HIDE[b]) >= 0) { hideHit = true; break; } }
          if (!hideHit) { continue; }
          var item = node.closest('a,button,li') || node;
          hide(item);
        }
        if (!document.getElementById('kc-ops-menu-link')) {
          var opsLink = document.createElement('a');
          opsLink.id = 'kc-ops-menu-link';
          opsLink.href = 'http://localhost:3100/admin';
          opsLink.target = '_blank';
          opsLink.rel = 'noopener';
          opsLink.textContent = '代充运营';
          opsLink.style.cssText = 'display:flex;align-items:center;height:40px;padding:0 24px;border-radius:6px;color:inherit;text-decoration:none;font-weight:600;';
          nav.insertBefore(opsLink, nav.firstChild);
        }
        var nodes = nav.querySelectorAll('button,span');
        for (var j = 0; j < nodes.length; j++) {
          if (HIDE_GROUPS.indexOf(txt(nodes[j])) >= 0) {
            var grp = nodes[j].closest('[data-state]') || nodes[j].parentElement;
            if (grp) { hide(grp); }
          }
        }
      }

      // 品牌 + 货币（文本节点级，幂等）
      function cleanBrandAndMoney() {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        var n;
        while ((n = walker.nextNode())) {
          var v = n.nodeValue;
          if (!v) { continue; }
          var changed = v;
          if (/Xboard is best/i.test(changed)) { changed = changed.replace(/Xboard is best!?/gi, 'ChatGPT 官方渠道代充，3 分钟自动到账'); }
          if (changed.indexOf('Xboard') >= 0) { changed = changed.replace(/Xboard/g, 'KC 直供'); }
          if (changed.indexOf('\u00a5') >= 0) { changed = changed.split('\u00a5').join('$'); }
          if (changed.indexOf('\uffe5') >= 0) { changed = changed.split('\uffe5').join('$'); }
          if (/\d\s*元/.test(changed)) { changed = changed.replace(/(\d)\s*元/g, '$1'); }
          if (changed !== v) { n.nodeValue = changed; }
        }
        if (document.title && document.title.indexOf('Xboard') >= 0) {
          document.title = document.title.replace(/Xboard/g, 'KC 直供');
        }
      }

      // 表格列（列头文本精确匹配 → 隐藏该列全部单元）
      function cleanTables() {
        var tables = document.querySelectorAll('table');
        for (var t = 0; t < tables.length; t++) {
          var tbl = tables[t];
          var ths = tbl.querySelectorAll('thead th');
          var rows = null;
          for (var i = 0; i < ths.length; i++) {
            var head = txt(ths[i]);
            if (HIDE_COLUMNS.indexOf(head) < 0) { continue; }
            var ci = ths[i].cellIndex;
            if (ci < 0) { continue; }
            if (!rows) { rows = tbl.querySelectorAll('tr'); }
            hide(ths[i]);
            for (var r = 0; r < rows.length; r++) {
              var cell = rows[r].cells[ci];
              if (cell) { hide(cell); }
            }
          }
        }
      }

      // 表单行 / 设置页签（标签文本精确匹配）
      function cleanLabelRows() {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        var n;
        while ((n = walker.nextNode())) {
          var t = (n.nodeValue || '').trim();
          if (!t || t.length > 14 || !LABEL_SET[t]) { continue; }
          var el = n.parentElement;
          if (!el) { continue; }
          var btn = el.closest('a,button');
          if (btn && txt(btn).length <= t.length + 2) { hide(btn); continue; }
          var row = upTo(el, isSpaceY, 5);
          if (row) { hide(row); }
        }
      }

      // 仪表盘卡片 / 弹窗区块（标题文本精确匹配 → 隐藏所属圆角卡片）
      function cleanCards() {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        var n;
        while ((n = walker.nextNode())) {
          var t = (n.nodeValue || '').trim();
          if (!t || t.length > 14) { continue; }
          if (!CARD_SET[t] && !SECTION_SET[t]) { continue; }
          var el = n.parentElement;
          if (!el) { continue; }
          var card = upTo(el, isRounded, 6);
          if (card) { hide(card); }
        }
      }

      // 行操作下拉菜单项
      function cleanMenuItems() {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        var n;
        while ((n = walker.nextNode())) {
          var t = (n.nodeValue || '').trim();
          if (!t || t.length > 20 || !MENUITEM_SET[t]) { continue; }
          var el = n.parentElement;
          var item = el && el.closest('[role="menuitem"],[data-radix-collection-item]');
          if (item) { hide(item); }
        }
      }

      function sweep() {
        try { cleanMenu(); } catch (e) { }
        try { cleanBrandAndMoney(); } catch (e) { }
        try { cleanTables(); } catch (e) { }
        try { cleanLabelRows(); } catch (e) { }
        try { cleanCards(); } catch (e) { }
        try { cleanMenuItems(); } catch (e) { }
      }

      // ---------- ④ 调度 ----------
      var timer = null;
      function debounced() {
        if (timer) { return; }
        timer = setTimeout(function () { timer = null; sweep(); }, 250);
      }
      function quickSweep() { setTimeout(sweep, 60); }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          sweep();
          setTimeout(sweep, 800);
          setTimeout(sweep, 2200);
        });
      } else {
        quickSweep();
      }
      window.addEventListener('hashchange', function () { setTimeout(sweep, 350); });
      setInterval(sweep, 1500);
      try {
        new MutationObserver(debounced).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) { }
    })();
  </script>
</head>

<body>
  <div id="root"></div>
</body>

</html>
