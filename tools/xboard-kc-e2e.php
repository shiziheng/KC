<?php

/**
 * 段C2 端到端验收：模拟 Xboard 订单履约，验证 order.open.after 自动发卡。
 *
 * 用法：
 *   php /www/kc_e2e.php reset         重置测试订单为「待支付」
 *   php /www/kc_e2e.php open          触发订单履约（会走钩子 -> 发卡）
 *   php /www/kc_e2e.php cards         查看插件发卡记录
 *   php /www/kc_e2e.php kcissue       查看 KC 侧发放记录（需 KC 接口）
 */

require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\Order;
use App\Services\OrderService;
use Illuminate\Support\Facades\DB;
use Plugin\KcIntegration\Models\KcCard;

$action = $argv[1] ?? 'cards';
$tradeNo = $argv[2] ?? '2026092518095890368778459';

switch ($action) {
    case 'reset':
        // 把订单打回「开通中」，并清掉插件记录，便于重复验证。
        // 注意：OrderService::open() 内部用 lockCurrentOrderWhenStatus(STATUS_PROCESSING)，
        // 只有 PROCESSING(1) 状态才会真正执行履约；PENDING(0) 会直接 return。
        DB::table('v2_plugin_kc_cards')->where('trade_no', $tradeNo)->delete();
        Order::where('trade_no', $tradeNo)->update([
            'status'     => Order::STATUS_PROCESSING,
            'paid_at'    => null,
            'updated_at' => time(),
        ]);
        $o = Order::where('trade_no', $tradeNo)->first();
        echo "reset order id={$o->id} status={$o->status} (1=开通中)\n";
        break;

    case 'open':
        $order = Order::where('trade_no', $tradeNo)->first();
        if (!$order) {
            echo "ORDER_NOT_FOUND\n";
            exit(1);
        }
        echo "before: status={$order->status}\n";
        // OrderService 构造需要 Order 实例
        $service = new OrderService($order);
        $service->open();
        $after = Order::where('trade_no', $tradeNo)->first();
        echo "after: status={$after->status}\n";
        break;

    case 'cards':
        $rows = KcCard::orderBy('id', 'desc')->limit(10)->get();
        echo "plugin_cards=" . $rows->count() . "\n";
        foreach ($rows as $r) {
            echo json_encode([
                'trade_no'  => $r->trade_no,
                'plan_type' => $r->plan_type,
                'cdk'       => $r->cdk_code,
                'status'    => $r->status,
                'error'     => $r->error_msg,
                'attempts'  => $r->attempts,
                'user_ref'  => $r->user_ref,
            ], JSON_UNESCAPED_UNICODE) . "\n";
        }
        break;

    case 'clear':
        $n = DB::table('v2_plugin_kc_cards')->delete();
        echo "cleared={$n}\n";
        break;

    default:
        echo "unknown action\n";
}
