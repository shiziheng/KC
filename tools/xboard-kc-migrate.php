<?php
// 段C4：执行插件迁移（加 kc_status / kc_synced_at 列）+ 结构核对
require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

// 1) 迁移前
echo "=== 迁移前列 ===\n";
$cols = Schema::getColumnListing('v2_plugin_kc_cards');
echo implode(', ', $cols) . "\n";

// 2) 执行迁移
echo "\n=== 执行迁移 ===\n";
try {
    $out = Illuminate\Support\Facades\Artisan::call('migrate', [
        '--path'  => 'plugins/KcIntegration/database/migrations',
        '--force' => true,
    ]);
    echo Illuminate\Support\Facades\Artisan::output();
} catch (\Throwable $e) {
    echo '迁移异常: ' . $e->getMessage() . "\n";
}

// 3) 迁移后
echo "\n=== 迁移后列 ===\n";
$cols2 = Schema::getColumnListing('v2_plugin_kc_cards');
echo implode(', ', $cols2) . "\n";

// 4) 关键列是否存在
foreach (['kc_status', 'kc_synced_at'] as $c) {
    echo "  has {$c}: " . (Schema::hasColumn('v2_plugin_kc_cards', $c) ? 'YES' : 'NO') . "\n";
}

// 5) 现有数据
echo "\n=== 现有记录 ===\n";
$rows = DB::table('v2_plugin_kc_cards')->select('id', 'trade_no', 'status', 'kc_status', 'cdk_code')->get();
foreach ($rows as $r) {
    echo "  id={$r->id} trade_no={$r->trade_no} status={$r->status} kc_status=" . ($r->kc_status ?? '(null)') . " cdk={$r->cdk_code}\n";
}

// 6) 路由核对
echo "\n=== 路由 ===\n";
foreach (app('router')->getRoutes() as $route) {
    $uri = $route->uri();
    if (strpos($uri, 'kc') !== false) {
        echo '  ' . implode('|', $route->methods()) . '  /' . $uri . "\n";
    }
}
