<?php
// tools/xboard-theme-state.php — 读取线上 custom_html 权威长度/md5（部署后零漂移核查用）
// 用法：
//   docker cp tools/xboard-theme-state.php xboard:/www/_ts.php
//   docker exec xboard php /www/_ts.php
// 期望：len/md5 与「本地三源拼接（tools/kc_{activate,panel,theme}_inject.html）」逐字节一致
require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$ts = new App\Services\ThemeService();
$cfg = $ts->getConfig('Xboard');
$html = (string) ($cfg['custom_html'] ?? '');
echo 'len=' . strlen($html) . "\n";
echo 'md5=' . md5($html) . "\n";
echo 'has_kc_cb_buy=' . (strpos($html, 'kc-cb-buy') !== false ? '1' : '0') . "\n";
echo 'has_kcOpenCardBuy=' . (strpos($html, 'kcOpenCardBuy') !== false ? '1' : '0') . "\n";
echo 'has_kcBuyShell=' . (strpos($html, 'KC_BUY_SHELL') !== false ? '1' : '0') . "\n";
