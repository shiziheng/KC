<?php
// FEAT-005 S1：备份当前 custom_html 到容器内 /www/_backup_custom_html.txt
// 配合 docker cp 导出回滚文件（回滚 = 用备份内容调 ThemeService::updateConfig 还原）
require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$ts = new App\Services\ThemeService();
$cfg = $ts->getConfig('Xboard');
$html = (string) ($cfg['custom_html'] ?? '');

file_put_contents('/www/_backup_custom_html.txt', $html);
echo "备份完成 长度: " . strlen($html) . "\n";
echo "包含激活注入: " . (strpos($html, 'kcActivateLoaded') !== false ? 'YES' : 'NO') . "\n";
echo "包含兑卡面板: " . (strpos($html, 'kcPanelLoaded') !== false ? 'YES' : 'NO') . "\n";
echo "包含主题注入: " . (strpos($html, 'kcThemeLoaded') !== false ? 'YES' : 'NO') . "\n";
