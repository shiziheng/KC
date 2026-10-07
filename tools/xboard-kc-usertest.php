<?php

/**
 * 段C2 验收：模拟登录用户访问插件路由，验证卡密查询。
 * 用法：php /www/kc_usertest.php
 */

require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\User;
use Illuminate\Support\Facades\Http;

$userId  = 3;
$tradeNo = '2026092518095890368778459';

$user = User::find($userId);
echo "user={$user->email}\n";

// 为用户创建一个 Sanctum token 用于测试
$token = $user->createToken('kc-c2-test')->plainTextToken;
echo "token_created=" . substr($token, 0, 25) . "...\n";

$base = 'http://127.0.0.1:7001';

echo "\n=== GET /user/kc/card?trade_no=... ===\n";
$r = Http::withToken($token)->timeout(10)->get($base . '/user/kc/card', ['trade_no' => $tradeNo]);
echo "status=" . $r->status() . "\n";
echo "body=" . $r->body() . "\n";

echo "\n=== GET /user/kc/cards ===\n";
$r2 = Http::withToken($token)->timeout(10)->get($base . '/user/kc/cards');
echo "status=" . $r2->status() . "\n";
echo "body=" . $r2->body() . "\n";

echo "\n=== 越权测试：查别人的订单 ===\n";
$r3 = Http::withToken($token)->timeout(10)->get($base . '/user/kc/card', ['trade_no' => 'NOT-MY-ORDER-123']);
echo "status=" . $r3->status() . "\n";
echo "body=" . $r3->body() . "\n";

// 清理测试 token
$user->tokens()->where('name', 'kc-c2-test')->delete();
echo "\ntoken_cleaned\n";
