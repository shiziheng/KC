<?php

namespace Plugin\KcIntegration\Support;

use Illuminate\Support\Facades\Http;

/**
 * 读取 KC 已持久化的供应商健康摘要。
 * 该类不会触发 Zovo 请求，也不会接触 Session、API Key 或代理内容。
 */
class SupplierHealthClient
{
    public function __construct(
        protected string $baseUrl,
        protected string $integrationKey,
        protected int $timeout = 2,
        protected int $connectTimeout = 1
    ) {
        $this->baseUrl = rtrim($this->baseUrl, '/');
    }

    public function fetch(): array
    {
        if ($this->baseUrl === '' || $this->integrationKey === '') {
            return ['ok' => false, 'status' => 0, 'health' => $this->unknown(), 'error' => 'KC 健康状态未配置'];
        }

        try {
            $response = Http::withHeaders([
                'X-Integration-Key' => $this->integrationKey,
                'Accept' => 'application/json',
            ])
                ->timeout(max(1, min(3, $this->timeout)))
                ->connectTimeout(max(1, min(2, $this->connectTimeout)))
                ->get($this->baseUrl . '/api/integration/health');
        } catch (\Throwable $e) {
            return ['ok' => false, 'status' => 0, 'health' => $this->unknown(), 'error' => 'KC 健康状态不可达'];
        }

        $json = $response->json();
        $health = is_array($json) ? ($json['data']['supplier_health'] ?? null) : null;
        if ($response->failed() || !is_array($health)) {
            return ['ok' => false, 'status' => $response->status(), 'health' => $this->unknown(), 'error' => 'KC 健康状态响应异常'];
        }

        return ['ok' => true, 'status' => $response->status(), 'health' => $this->sanitize($health), 'error' => ''];
    }

    public function sellableFor(string $planType): bool
    {
        return $this->sellableIn($this->fetch(), $planType);
    }

    public function sellableIn(array $result, string $planType): bool
    {
        if (!$result['ok']) return false;
        $health = $result['health'];
        if (($health['status'] ?? '') !== 'healthy' || ($health['sellable'] ?? false) !== true) return false;
        foreach ((array) ($health['plans'] ?? []) as $plan) {
            if ((string) ($plan['key'] ?? '') === $planType) {
                return ($plan['available'] ?? false) === true;
            }
        }
        return false;
    }

    public function sanitize(array $health): array
    {
        $plans = [];
        foreach ((array) ($health['plans'] ?? []) as $plan) {
            $key = trim((string) ($plan['key'] ?? ''));
            if ($key === '') continue;
            $plans[] = [
                'key' => $key,
                'name' => mb_substr((string) ($plan['name'] ?? $key), 0, 80),
                'available' => (bool) ($plan['available'] ?? false),
            ];
        }
        return [
            'status' => (string) ($health['status'] ?? 'unknown'),
            'sellable' => (bool) ($health['sellable'] ?? false),
            'reason_code' => (string) ($health['reason_code'] ?? 'initial'),
            'reason' => mb_substr((string) ($health['reason'] ?? '暂不可售'), 0, 120),
            'checked_at' => $health['checked_at'] ?? null,
            'last_success_at' => $health['last_success_at'] ?? null,
            'balance' => is_numeric($health['balance'] ?? null) ? (float) $health['balance'] : null,
            'plans' => $plans,
            'recovery_ready' => (bool) ($health['recovery_ready'] ?? false),
            'manual_override' => (bool) ($health['manual_override'] ?? false),
            'mock' => (bool) ($health['mock'] ?? true),
        ];
    }

    protected function unknown(): array
    {
        return $this->sanitize([
            'status' => 'unknown', 'sellable' => false,
            'reason_code' => 'api_unavailable', 'reason' => 'KC 健康状态不可达',
            'plans' => [], 'mock' => true,
        ]);
    }
}
