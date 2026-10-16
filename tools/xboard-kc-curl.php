<?php
// ⚠️ 已退役（v2.1.0 · Xboard 代码摘除）：本文件属 Xboard 时代工具链，仅作历史/回滚参考，日常开发与部署不再使用。

/**
 * 段C2 联调探针：从 Xboard 容器内直连 KC，验证网络与契约。
 * 用法：php /www/kc_curl.php
 */

require __DIR__ . '/vendor/autoload.php';
$app = require_once __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\Http;

$base = 'http://host.docker.internal:3100';
$key  = 'ik_test_suite_key_0001';

echo "=== 1. health ===\n";
try {
    $r = Http::withHeaders(['X-Integration-Key' => $key])->timeout(5)->get($base . '/api/integration/health');
    echo "status=" . $r->status() . "\n";
    echo "body=" . mb_substr($r->body(), 0, 400) . "\n";
} catch (\Throwable $e) {
    echo "ERROR: " . $e->getMessage() . "\n";
}

echo "\n=== 2. issue (test ref) ===\n";
$ref = 'XC2-TEST-' . date('YmdHis');
try {
    $r = Http::withHeaders(['X-Integration-Key' => $key, 'Accept' => 'application/json'])
        ->timeout(5)
        ->asJson()
        ->post($base . '/api/integration/cdk/issue', [
            'ref'       => $ref,
            'plan_type' => 'plus',
            'source'    => 'xboard',
            'user_ref'  => 'probe@test.local',
        ]);
    echo "ref={$ref}\n";
    echo "status=" . $r->status() . "\n";
    echo "body=" . mb_substr($r->body(), 0, 600) . "\n";
    echo "json.success=" . var_export($r->json('success'), true) . "\n";
    echo "json.data.cdk=" . var_export($r->json('data.cdk'), true) . "\n";
} catch (\Throwable $e) {
    echo "ERROR: " . $e->getMessage() . "\n";
}

echo "\n=== 3. issue again (idempotency) ===\n";
try {
    $r = Http::withHeaders(['X-Integration-Key' => $key, 'Accept' => 'application/json'])
        ->timeout(5)
        ->asJson()
        ->post($base . '/api/integration/cdk/issue', [
            'ref'       => $ref,
            'plan_type' => 'plus',
            'source'    => 'xboard',
            'user_ref'  => 'probe@test.local',
        ]);
    echo "status=" . $r->status() . "\n";
    echo "body=" . mb_substr($r->body(), 0, 600) . "\n";
    echo "reused=" . var_export($r->json('data.reused'), true) . "\n";
} catch (\Throwable $e) {
    echo "ERROR: " . $e->getMessage() . "\n";
}
