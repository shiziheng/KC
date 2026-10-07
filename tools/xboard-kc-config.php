<?php

/**
 * 段C2 配置脚本：写入插件配置。
 * 用法：php /www/kc_config.php '<json>'
 */

require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\Plugin;

$json = $argv[1] ?? '{}';
$values = json_decode($json, true);
if (!is_array($values)) {
    echo "BAD_JSON\n";
    exit(1);
}

Plugin::where('code', 'kc_integration')->update([
    'config'     => json_encode($values),
    'updated_at' => now(),
]);

$row = Plugin::where('code', 'kc_integration')->first();
echo "config_saved=" . $row->config . "\n";
echo "enabled=" . var_export((bool) $row->is_enabled, true) . "\n";
