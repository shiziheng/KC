<?php
// 段C4 第1步验收：代理路由 /user/kc/status 的 HTTP 行为
// 用 Sanctum token 模拟登录，直接打 HTTP 侧（验证 Octane 已加载新路由）
require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\User;
use App\Models\Order;

$tradeNo = '2026092518095890368778459';
$base = 'http://127.0.0.1:7001';

function httpGet($url, $token = null) {
    $ch = curl_init($url);
    $headers = ['Accept: application/json'];
    if ($token) { $headers[] = 'Authorization: Bearer ' . $token; }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 10,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['code' => $code, 'body' => $body];
}

// 找到订单所属用户
$order = Order::where('trade_no', $tradeNo)->first();
if (!$order) { echo "订单不存在\n"; exit(1); }
$owner = User::find($order->user_id);
echo "订单 {$tradeNo} 属用户 id={$owner->id} ({$owner->email})\n\n";

// 1) 未登录
$r = httpGet("$base/user/kc/status?trade_no={$tradeNo}");
echo "1) 未登录         → HTTP {$r['code']}  " . mb_substr($r['body'], 0, 120) . "\n";

// 2) 拥有者访问
$tok = $owner->createToken('kc-c4-status-test')->plainTextToken;
$r = httpGet("$base/user/kc/status?trade_no={$tradeNo}", $tok);
echo "2) 拥有者访问     → HTTP {$r['code']}  " . mb_substr($r['body'], 0, 300) . "\n";

// 3) 越权（换另一个用户）
$other = User::where('id', '!=', $owner->id)->first();
if ($other) {
    $tok2 = $other->createToken('kc-c4-status-test2')->plainTextToken;
    $r = httpGet("$base/user/kc/status?trade_no={$tradeNo}", $tok2);
    echo "3) 越权访问       → HTTP {$r['code']}  " . mb_substr($r['body'], 0, 160) . "\n";
    $other->tokens()->where('name', 'kc-c4-status-test2')->delete();
} else {
    echo "3) 越权访问       → 跳过（只有一个用户）\n";
}

// 4) 缺参数
$r = httpGet("$base/user/kc/status", $tok);
echo "4) 缺 trade_no    → HTTP {$r['code']}  " . mb_substr($r['body'], 0, 160) . "\n";

// 5) 不存在的订单号
$r = httpGet("$base/user/kc/status?trade_no=NOT-EXIST-000", $tok);
echo "5) 不存在订单     → HTTP {$r['code']}  " . mb_substr($r['body'], 0, 160) . "\n";

// 清理
$owner->tokens()->where('name', 'kc-c4-status-test')->delete();

// 迁移后的 KC 状态
$card = DB::table('v2_plugin_kc_cards')->where('trade_no', $tradeNo)->first();
echo "\n=== 当前插件记录 ===\n";
echo "  kc_status={$card->kc_status}  kc_synced_at=" . ($card->kc_synced_at ?? '(null)') . "  cdk={$card->cdk_code}\n";
