<?php
// 段C3：把「去开通」注入脚本写入 Xboard 主题配置 custom_html
// FEAT-004 D1+D3：拼接「订单页激活卡片」+「全站兑卡/充值面板」两份注入
// FEAT-005 S1：+第三份「KC 主题注入（顶部导航框架）」
// ⚠️ 已退役（v2.0.0 · Stage 3.9）：Xboard 退场，注入已清除；本脚本保留为回滚资产（配合 xboard-apply-custom-html.js）。
// 走 ThemeService::updateConfig()，保留 field_name 白名单校验（不绕过）
require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$srcs = ['/www/kc_activate_inject.html', '/www/kc_panel_inject.html', '/www/kc_theme_inject.html', '/www/kc_home_portal.html', '/www/kc_plan_double_price.html'];
$parts = [];
foreach ($srcs as $src) {
    if (!file_exists($src)) {
        fwrite(STDERR, "缺少源文件: {$src}\n");
        exit(1);
    }
    $html = file_get_contents($src);
    if ($html === false || trim($html) === '') {
        fwrite(STDERR, "源文件为空: {$src}\n");
        exit(1);
    }
    $parts[] = $html;
}
$html = implode("\n", $parts);

$ts = new App\Services\ThemeService();
$before = $ts->getConfig('Xboard');
echo "=== 写入前 custom_html 长度: " . strlen((string) ($before['custom_html'] ?? '')) . "\n";

$ok = $ts->updateConfig('Xboard', ['custom_html' => $html]);
echo "updateConfig 返回: " . var_export($ok, true) . "\n";

$after = $ts->getConfig('Xboard');
$val = (string) ($after['custom_html'] ?? '');
echo "=== 写入后 custom_html 长度: " . strlen($val) . "\n";
echo "包含 prefillCdkFromUrl 式脚本: " . (strpos($val, 'kcActivateLoaded') !== false ? 'YES' : 'NO') . "\n";
echo "包含 KC_BASE: " . (strpos($val, 'KC_BASE') !== false ? 'YES' : 'NO') . "\n";
echo "包含兑卡面板(kcPanelLoaded): " . (strpos($val, 'kcPanelLoaded') !== false ? 'YES' : 'NO') . "\n";
echo "包含充值入口(kc-float-topup): " . (strpos($val, 'kc-float-topup') !== false ? 'YES' : 'NO') . "\n";
echo "包含主题注入(kcThemeLoaded): " . (strpos($val, 'kcThemeLoaded') !== false ? 'YES' : 'NO') . "\n";
echo "包含顶部导航(kc-topbar): " . (strpos($val, 'kc-topbar') !== false ? 'YES' : 'NO') . "\n";
echo "包含首页门户(kc-home-portal): " . (strpos($val, 'kc-home-portal') !== false ? 'YES' : 'NO') . "\n";
echo "\n--- 前后各 120 字符 ---\n";
echo "HEAD: " . substr($val, 0, 120) . "\n";
echo "TAIL: " . substr($val, -120) . "\n";
