<?php

namespace Plugin\KcIntegration\Models;

use Illuminate\Database\Eloquent\Model;

/** 余额与补偿资金流水（金额单位：分）。 */
class KcLedger extends Model
{
    protected $table = 'v2_plugin_kc_ledger';

    protected $guarded = ['id'];

    protected $casts = [
        'user_id' => 'integer',
        'order_id' => 'integer',
        'amount' => 'integer',
        'balance_before' => 'integer',
        'balance_after' => 'integer',
        'metadata' => 'array',
    ];

    public const TYPE_TOPUP = 'topup';
    public const TYPE_ORDER_DEBIT = 'order_debit';
    public const TYPE_COMPENSATION_CREDIT = 'compensation_credit';
    public const TYPE_MANUAL_ADJUSTMENT = 'manual_adjustment';

    public static array $typeMap = [
        self::TYPE_TOPUP => '充值到账',
        self::TYPE_ORDER_DEBIT => '订单扣款',
        self::TYPE_COMPENSATION_CREDIT => '失败补偿',
        self::TYPE_MANUAL_ADJUSTMENT => '人工调整',
    ];

    public function toPublicPayload(): array
    {
        return [
            'id' => (int) $this->id,
            'trade_no' => (string) ($this->trade_no ?? ''),
            'type' => (string) $this->type,
            'type_cn' => self::$typeMap[$this->type] ?? '余额变动',
            'amount' => (int) $this->amount,
            'balance_before' => (int) $this->balance_before,
            'balance_after' => (int) $this->balance_after,
            'source' => (string) $this->source,
            'created_at' => $this->created_at?->timestamp,
        ];
    }
}

