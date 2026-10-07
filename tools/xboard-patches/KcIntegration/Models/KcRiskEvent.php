<?php

namespace Plugin\KcIntegration\Models;

use Illuminate\Database\Eloquent\Model;

/** 风险事件。模型不接收也不输出 IP、CDK、Session 等原始值。 */
class KcRiskEvent extends Model
{
    protected $table = 'v2_plugin_kc_risk_events';

    protected $guarded = ['id'];

    protected $casts = [
        'observed_count' => 'integer',
        'window_seconds' => 'integer',
        'cooldown_seconds' => 'integer',
        'user_id' => 'integer',
        'metadata' => 'array',
        'expires_at' => 'datetime',
        'released_at' => 'datetime',
    ];

    public function toAdminPayload(): array
    {
        return [
            'id' => (int) $this->id,
            'event_key' => (string) $this->event_key,
            'endpoint' => (string) $this->endpoint,
            'scope_type' => (string) $this->scope_type,
            'scope_hash' => (string) $this->scope_hash,
            'rule' => (string) $this->rule,
            'action' => (string) $this->action,
            'event_type' => (string) $this->event_type,
            'observed_count' => (int) $this->observed_count,
            'window_seconds' => (int) $this->window_seconds,
            'cooldown_seconds' => (int) $this->cooldown_seconds,
            'user_id' => $this->user_id !== null ? (int) $this->user_id : null,
            'trade_no' => $this->trade_no ? (string) $this->trade_no : null,
            'expires_at' => $this->expires_at?->timestamp,
            'released_at' => $this->released_at?->timestamp,
            'released_by' => $this->released_by ? (string) $this->released_by : null,
            'metadata' => is_array($this->metadata) ? $this->metadata : [],
            'created_at' => $this->created_at?->timestamp,
        ];
    }
}


