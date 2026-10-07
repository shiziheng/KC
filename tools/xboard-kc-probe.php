<?php

/**
 * 段C2 安装/验收辅助脚本
 * 用法：php /www/kc_probe.php <action>
 */

require __DIR__ . '/vendor/autoload.php';

$app = require_once __DIR__ . '/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();

use App\Models\Plugin;
use App\Services\Plugin\PluginManager;

$action = $argv[1] ?? 'info';
$pm = app(PluginManager::class);

switch ($action) {
    case 'info':
        $p = $pm->getPluginPath('kc_integration');
        echo "PATH=" . $p . "\n";
        echo "config.json=" . (file_exists($p . '/config.json') ? 'yes' : 'no') . "\n";
        echo "Plugin.php=" . (file_exists($p . '/Plugin.php') ? 'yes' : 'no') . "\n";
        $raw = file_get_contents($p . '/config.json');
        $cfg = json_decode($raw, true);
        echo "json_valid=" . (json_last_error() === JSON_ERROR_NONE ? 'yes' : ('no:' . json_last_error_msg())) . "\n";
        echo "code=" . ($cfg['code'] ?? 'MISSING') . "\n";
        echo "type=" . ($cfg['type'] ?? 'MISSING') . "\n";
        echo "version=" . ($cfg['version'] ?? 'MISSING') . "\n";
        echo "db_row=" . json_encode(Plugin::where('code', 'kc_integration')->first()) . "\n";
        break;

    case 'install':
        try {
            $ok = $pm->install('kc_integration');
            echo "install=" . ($ok ? 'OK' : 'FALSE') . "\n";
        } catch (\Throwable $e) {
            echo "install_ERROR=" . $e->getMessage() . "\n";
        }
        echo "db_row=" . json_encode(Plugin::where('code', 'kc_integration')->first()) . "\n";
        break;

    case 'enable':
        try {
            $ok = $pm->enable('kc_integration');
            echo "enable=" . ($ok ? 'OK' : 'FALSE') . "\n";
        } catch (\Throwable $e) {
            echo "enable_ERROR=" . $e->getMessage() . "\n";
        }
        $row = Plugin::where('code', 'kc_integration')->first();
        echo "enabled=" . ($row ? var_export((bool) $row->is_enabled, true) : 'NULL') . "\n";
        break;

    case 'class':
        $cls = 'Plugin\\KcIntegration\\Plugin';
        echo "plugin_class=" . (class_exists($cls) ? 'yes' : 'no') . "\n";
        $mcls = 'Plugin\\KcIntegration\\Models\\KcCard';
        echo "model_class=" . (class_exists($mcls) ? 'yes' : 'no') . "\n";
        $ccls = 'Plugin\\KcIntegration\\Controllers\\CardController';
        echo "controller_class=" . (class_exists($ccls) ? 'yes' : 'no') . "\n";
        break;

    case 'table':
        echo "table_exists=" . (Illuminate\Support\Facades\Schema::hasTable('v2_plugin_kc_cards') ? 'yes' : 'no') . "\n";
        try {
            echo "rows=" . json_encode(
                Illuminate\Support\Facades\DB::table('v2_plugin_kc_cards')->get()->toArray()
            ) . "\n";
        } catch (\Throwable $e) {
            echo "rows_ERROR=" . $e->getMessage() . "\n";
        }
        break;

    case 'routes':
        $routes = app('router')->getRoutes();
        $hit = [];
        foreach ($routes as $r) {
            $uri = $r->uri();
            if (str_contains($uri, 'kc')) {
                $hit[] = implode(',', $r->methods()) . ' /' . $uri . '  middleware=' . json_encode($r->middleware());
            }
        }
        echo "kc_routes=" . count($hit) . "\n";
        echo implode("\n", $hit) . "\n";
        break;

    case 'orders':
        $orders = App\Models\Order::orderBy('id', 'desc')->limit(5)->get(['id', 'trade_no', 'user_id', 'plan_id', 'period', 'status', 'total_amount']);
        foreach ($orders as $o) {
            echo json_encode($o->toArray()) . "\n";
        }
        break;

    case 'plans':
        foreach (App\Models\Plan::get(['id', 'name', 'prices', 'show', 'sell']) as $pl) {
            echo json_encode($pl->toArray()) . "\n";
        }
        break;

    case 'uninstall':
        try {
            $pm->disable('kc_integration');
            $pm->uninstall('kc_integration');
            echo "uninstall=OK\n";
        } catch (\Throwable $e) {
            echo "uninstall_ERROR=" . $e->getMessage() . "\n";
        }
        break;

    default:
        echo "unknown action: {$action}\n";
}
