<?php

namespace Plugin\KcIntegration\Services;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Plugin\KcIntegration\Models\KcRiskEvent;

/**
 * FEAT-018 S7 风险判定服务。
 *
 * 设计边界：请求中的 IP、CDK、Session 和目标账号只在内存中短暂参与计算，
 * 落库值一律是 HMAC-SHA256；Session/Token 不进入日志、metadata 或风险表。
 */
class RiskService
{
    private const ACTIONS = ['allow', 'challenge', 'block', 'manual'];

    private const DEFAULT_RULES = [
        'redeem_ip' => ['endpoint' => 'redeem', 'scope' => 'ip', 'threshold' => 12, 'window' => 600, 'cooldown' => 1800, 'action' => 'block'],
        'redeem_cdk' => ['endpoint' => 'redeem', 'scope' => 'cdk', 'threshold' => 4, 'window' => 600, 'cooldown' => 1800, 'action' => 'block'],
        'redeem_account' => ['endpoint' => 'redeem', 'scope' => 'account', 'threshold' => 4, 'window' => 3600, 'cooldown' => 3600, 'action' => 'manual'],
        'redeem_failure' => ['endpoint' => 'redeem', 'scope' => 'cdk', 'event_type' => 'failure', 'threshold' => 3, 'window' => 600, 'cooldown' => 1800, 'action' => 'challenge'],
        'topup_ip' => ['endpoint' => 'topup', 'scope' => 'ip', 'threshold' => 30, 'window' => 600, 'cooldown' => 1800, 'action' => 'block'],
        'topup_user' => ['endpoint' => 'topup', 'scope' => 'user', 'threshold' => 20, 'window' => 600, 'cooldown' => 1800, 'action' => 'block'],
    ];

    public function guardRedeem(Request $request, string $cdk, ?string $session = null, bool $start = true): array
    {
        $identifiers = [
            'ip' => (string) $request->ip(),
            'cdk' => $cdk,
        ];
        if ($start && $session !== null && $session !== '') {
            $identifiers['account'] = $this->accountIdentifier($session);
        }
        return $this->guard('redeem', $identifiers, null, $start ? null : ['redeem_ip', 'redeem_cdk']);
    }

    public function guardTopup(Request $request, int $userId): array
    {
        return $this->guard('topup', [
            'ip' => (string) $request->ip(),
            'user' => 'user:' . $userId,
        ], $userId, ['topup_ip', 'topup_user']);
    }

    /** 记录 KC 返回的失败，不写入失败原因中的原始凭据。 */
    public function recordRedeemFailure(Request $request, string $cdk, ?string $session = null, ?int $userId = null): void
    {
        $identifiers = ['ip' => (string) $request->ip(), 'cdk' => $cdk];
        if ($session !== null && $session !== '') {
            $identifiers['account'] = $this->accountIdentifier($session);
        }
        foreach (['redeem_failure'] as $ruleName) {
            $rule = $this->rule($ruleName);
            $raw = $identifiers[$rule['scope']] ?? '';
            if ($raw === '') continue;
            $this->writeEvent($rule['endpoint'], $rule['scope'], $raw, $ruleName, 'allow', 'failure', 0, $rule['window'], 0, $userId);
        }
    }

    public function guard(string $endpoint, array $identifiers, ?int $userId = null, ?array $ruleNames = null): array
    {
        $ruleNames = $ruleNames ?? array_keys(self::DEFAULT_RULES);
        $best = ['allowed' => true, 'action' => 'allow', 'rule' => null, 'scope_type' => null, 'scope_hash' => null, 'retry_after' => 0];

        foreach ($ruleNames as $ruleName) {
            $rule = $this->rule($ruleName);
            if (($rule['endpoint'] ?? '') !== $endpoint) continue;
            $scope = (string) ($rule['scope'] ?? '');
            $raw = (string) ($identifiers[$scope] ?? '');
            if ($raw === '') continue;
            $hash = $this->fingerprint($scope, $raw);

            $active = KcRiskEvent::query()
                ->where('endpoint', $endpoint)
                ->where('scope_type', $scope)
                ->where('scope_hash', $hash)
                ->whereIn('action', ['challenge', 'block', 'manual'])
                ->whereNull('released_at')
                ->where(function ($q) {
                    $q->whereNull('expires_at')->orWhere('expires_at', '>', now());
                })
                ->orderByDesc('id')
                ->first();

            if ($active) {
                $candidate = $this->decision($active->action, $ruleName, $scope, $hash, $active->expires_at?->timestamp);
                if ($best['rule'] === null || $this->stronger($candidate['action'], $best['action'])) $best = $candidate;
                continue;
            }

            $since = now()->subSeconds((int) $rule['window']);
            $query = KcRiskEvent::query()
                ->where('endpoint', $endpoint)
                ->where('scope_type', $scope)
                ->where('scope_hash', $hash)
                ->where('created_at', '>=', $since)
                ->whereNull('released_at')
                ->whereIn('event_type', [$rule['event_type'] ?? 'attempt']);
            $count = (int) $query->count();

            // 失败规则只读取已发生的 failure 事件；当前尚未失败的请求不能预先计作一次失败。
            $isFailureRule = ($rule['event_type'] ?? 'attempt') === 'failure';
            $observedCount = $isFailureRule ? $count : $count + 1;

            if ($observedCount >= (int) $rule['threshold']) {
                $expiresAt = now()->addSeconds((int) $rule['cooldown']);
                $action = (string) $rule['action'];
                $this->writeEvent($endpoint, $scope, $raw, $ruleName, $action, 'attempt', $observedCount, (int) $rule['window'], (int) $rule['cooldown'], $userId, $expiresAt);
                $candidate = $this->decision($action, $ruleName, $scope, $hash, $expiresAt->timestamp);
            } elseif (!$isFailureRule) {
                $this->writeEvent($endpoint, $scope, $raw, $ruleName, 'allow', 'attempt', $observedCount, (int) $rule['window'], 0, $userId);
                $candidate = ['allowed' => true, 'action' => 'allow', 'rule' => $ruleName, 'scope_type' => $scope, 'scope_hash' => $hash, 'retry_after' => 0];
            } else {
                $candidate = ['allowed' => true, 'action' => 'allow', 'rule' => $ruleName, 'scope_type' => $scope, 'scope_hash' => $hash, 'retry_after' => 0];
            }

            if ($best['rule'] === null || $this->stronger($candidate['action'], $best['action'])) $best = $candidate;
        }

        return $best;
    }

    public function listEvents(array $filters = [], int $limit = 100): array
    {
        $query = KcRiskEvent::query()->orderByDesc('id')->limit(max(1, min(200, $limit)));
        foreach (['endpoint', 'scope_type', 'action', 'event_type'] as $key) {
            if (!empty($filters[$key])) $query->where($key, (string) $filters[$key]);
        }
        if (!empty($filters['scope_hash'])) $query->where('scope_hash', (string) $filters['scope_hash']);
        if (!empty($filters['user_id'])) $query->where('user_id', (int) $filters['user_id']);
        return $query->get()->map(fn (KcRiskEvent $event) => $event->toAdminPayload())->all();
    }

    public function release(string $scopeType, string $scopeHash, string $operator, ?string $endpoint = null, string $note = ''): int
    {
        $query = KcRiskEvent::query()
            ->where('scope_type', $scopeType)
            ->where('scope_hash', $scopeHash)
            ->whereNull('released_at');
        if ($endpoint !== null && $endpoint !== '') $query->where('endpoint', $endpoint);
        $events = $query->get();
        if ($events->isEmpty()) return 0;

        $now = now();
        foreach ($events as $event) {
            $event->released_at = $now;
            $event->released_by = substr($operator !== '' ? $operator : 'admin', 0, 191);
            $event->save();
            $this->writeEvent((string) $event->endpoint, (string) $event->scope_type, (string) $event->scope_hash, 'admin_release', 'allow', 'release', 0, 0, 0, $event->user_id, null, ['note' => mb_substr($note, 0, 200)] , true);
        }
        return $events->count();
    }

    public function rules(): array
    {
        $configured = admin_setting('kc_risk_rules', []);
        if (is_string($configured)) $configured = json_decode($configured, true) ?: [];
        if (!is_array($configured)) $configured = [];
        $rules = self::DEFAULT_RULES;
        foreach ($rules as $name => $defaults) {
            $input = is_array($configured[$name] ?? null) ? $configured[$name] : [];
            $rules[$name] = [
                'endpoint' => $defaults['endpoint'],
                'scope' => $defaults['scope'],
                'event_type' => $defaults['event_type'] ?? 'attempt',
                'threshold' => max(1, min(10000, (int) ($input['threshold'] ?? $defaults['threshold']))),
                'window' => max(10, min(86400, (int) ($input['window'] ?? $defaults['window']))),
                'cooldown' => max(0, min(604800, (int) ($input['cooldown'] ?? $defaults['cooldown']))),
                'action' => in_array(($input['action'] ?? $defaults['action']), self::ACTIONS, true) ? ($input['action'] ?? $defaults['action']) : $defaults['action'],
            ];
        }
        return $rules;
    }

    public function updateRules(array $input): array
    {
        $current = $this->rules();
        $allowed = [];
        foreach ($current as $name => $defaults) {
            if (!is_array($input[$name] ?? null)) continue;
            $row = $input[$name];
            $allowed[$name] = [
                'threshold' => max(1, min(10000, (int) ($row['threshold'] ?? $defaults['threshold']))),
                'window' => max(10, min(86400, (int) ($row['window'] ?? $defaults['window']))),
                'cooldown' => max(0, min(604800, (int) ($row['cooldown'] ?? $defaults['cooldown']))),
                'action' => in_array(($row['action'] ?? $defaults['action']), self::ACTIONS, true) ? ($row['action'] ?? $defaults['action']) : $defaults['action'],
            ];
        }
        admin_setting(['kc_risk_rules' => $allowed]);
        return $this->rules();
    }

    public function fingerprint(string $scopeType, string $value): string
    {
        $key = (string) config('app.key', 'kc-risk-fingerprint');
        return hash_hmac('sha256', $scopeType . ':' . $value, $key);
    }

    public function accountIdentifier(string $session): string
    {
        $candidate = trim($session);
        $decoded = json_decode($candidate, true);
        if (is_array($decoded)) {
            $values = [
                data_get($decoded, 'user.email'), data_get($decoded, 'user.id'), data_get($decoded, 'account.email'),
                data_get($decoded, 'account.id'), data_get($decoded, 'email'), data_get($decoded, 'user_id'), data_get($decoded, 'sub'),
            ];
            foreach ($values as $value) if (is_scalar($value) && trim((string) $value) !== '') return 'account:' . mb_strtolower(trim((string) $value));
        }
        return 'session:' . $candidate;
    }

    private function rule(string $name): array { return $this->rules()[$name] ?? self::DEFAULT_RULES[$name]; }

    private function decision(string $action, string $rule, string $scope, string $hash, ?int $retryAfter): array
    {
        return ['allowed' => $action === 'allow', 'action' => $action, 'rule' => $rule, 'scope_type' => $scope, 'scope_hash' => $hash, 'retry_after' => max(0, (int) ($retryAfter ? $retryAfter - now()->timestamp : 0))];
    }

    private function stronger(string $left, string $right): bool
    {
        $rank = ['allow' => 0, 'challenge' => 1, 'block' => 2, 'manual' => 3];
        return ($rank[$left] ?? 0) > ($rank[$right] ?? 0);
    }

    private function writeEvent(string $endpoint, string $scope, string $raw, string $rule, string $action, string $eventType, int $count, int $window, int $cooldown, ?int $userId = null, $expiresAt = null, array $metadata = [], bool $alreadyHashed = false): void
    {
        $hash = $alreadyHashed ? $raw : $this->fingerprint($scope, $raw);
        KcRiskEvent::create([
            'event_key' => (string) Str::uuid(), 'endpoint' => $endpoint, 'scope_type' => $scope, 'scope_hash' => $hash,
            'rule' => $rule, 'action' => $action, 'event_type' => $eventType, 'observed_count' => max(0, $count),
            'window_seconds' => max(0, $window), 'cooldown_seconds' => max(0, $cooldown), 'user_id' => $userId,
            'expires_at' => $expiresAt, 'metadata' => $metadata !== [] ? $metadata : null,
        ]);
    }
}


