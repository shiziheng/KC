<?php
// 段C4 服务端验收：终态短路 + KC 不可达降级
require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\User;
use App\Models\Order;
use Illuminate\Support\Facades\DB;
use App\Services\Plugin\PluginManager;

$tradeNo = '2026092518095890368778459';

function httpGet($url, $token = null) {
    $ch = curl_init($url);
    $headers = ['Accept: application/json'];
    if ($token) { $headers[] = 'Authorization: Bearer ' . $token; }
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 10]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['code' => $code, 'body' => $body];
}

$order = Order::where('trade_no', $tradeNo)->first();
$owner = User::find($order->user_id);
$tok = $owner->createToken('kc-c4-terminal-test')->plainTextToken;
$base = 'http://127.0.0.1:7001';

// ===== 1) 终态短路：置 completed，验证不再打 KC =====
echo "=== 1) 终态短路（kc_status=completed）===\n";
DB::table('v2_plugin_kc_cards')->where('trade_no', $tradeNo)
    ->update(['kc_status' => 'completed', 'kc_synced_at' => now()]);
$r = httpGet("$base/user/kc/status?trade_no={$tradeNo}", $tok);
echo "  HTTP {$r['code']}  {$r['body']}\n";
$j = json_decode($r['body'], true);
echo "  → terminal=" . var_export($j['data']['terminal'] ?? null, true)
   . " synced=" . var_export($j['data']['synced'] ?? null, true)
   . " （synced=false 表示走了缓存短路，没打 KC）\n";

// ===== 2) KC 不可达降级 =====
echo "\n=== 2) KC 不可达降级（kc_base_url → 死端口 :9999）===\n";
$plugin = \App\Models\Plugin::where('code', 'kc_integration')->first();
$origConfig = $plugin->config;

$cfg = json_decode($origConfig, true) ?: [];
$origUrl = $cfg['kc_base_url'] ?? '(none)';
$cfg['kc_base_url'] = 'http://host.docker.internal:9999';
$plugin->config = json_encode($cfg);
$plugin->save();

// 清缓存（HasPluginConfig 有 Cache）
try { \Illuminate\Support\Facades\Cache::flush(); } catch (\Throwable $e) {}

// 置为非终态，逼它实查
DB::table('v2_plugin_kc_cards')->where('trade_no', $tradeNo)
    ->update(['kc_status' => 'running', 'kc_synced_at' => null]);

$r = httpGet("$base/user/kc/status?trade_no={$tradeNo}", $tok);
echo "  HTTP {$r['code']}  " . mb_substr($r['body'], 0, 400) . "\n";
$j = json_decode($r['body'], true);
echo "  → kc_status=" . ($j['data']['kc_status'] ?? '?')
   . " stale=" . var_export($j['data']['stale'] ?? null, true)
   . " synced=" . var_export($j['data']['synced'] ?? null, true) . "\n";
echo "  ⚠️ 期望：HTTP 200（不报错）、返回缓存态 running、stale=true\n";

// 还原配置
$cfg['kc_base_url'] = $origUrl;
$plugin->config = json_encode($cfg);
$plugin->save();
try { \Illuminate\Support\Facades\Cache::flush(); } catch (\Throwable $e) {}
echo "\n  （已还原 kc_base_url={$origUrl}）\n";

// ===== 3) 还原后确认可实时同步（KC 仍返回开通中）=====
echo "\n=== 3) 还原后实查（KC 当前=开通中）===\n";
DB::table('v2_plugin_kc_cards')->where('trade_no', $tradeNo)
    ->update(['kc_status' => 'pending', 'kc_synced_at' => null]);
$r = httpGet("$base/user/kc/status?trade_no={$tradeNo}", $tok);
echo "  HTTP {$r['code']}  {$r['body']}\n";

$owner->tokens()->where('name', 'kc-c4-terminal-test')->delete();
