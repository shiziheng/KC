<?php
// 段C4：准备验收场景 —— 可重置插件表的 kc_status
// 用法：php xboard-kc-c4-fixture.php <action> [value]
require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\DB;

$action = $argv[1] ?? 'show';
$tradeNo = '2026092518095890368778459';

switch ($action) {
    case 'show':
        $r = DB::table('v2_plugin_kc_cards')->where('trade_no', $tradeNo)->first();
        echo json_encode($r, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n";
        break;

    case 'set':   // 强制写 kc_status（用于构造 running / pending 场景）
        $val = $argv[2] ?? 'pending';
        DB::table('v2_plugin_kc_cards')->where('trade_no', $tradeNo)
            ->update(['kc_status' => $val, 'kc_synced_at' => null]);
        echo "已置 kc_status={$val}\n";
        break;

    case 'reset': // 恢复到真实同步态
        DB::table('v2_plugin_kc_cards')->where('trade_no', $tradeNo)
            ->update(['kc_status' => 'pending', 'kc_synced_at' => null]);
        echo "已重置 kc_status=pending\n";
        break;

    default:
        echo "未知 action: {$action}\n";
}
