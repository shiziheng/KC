<?php

namespace Plugin\KcIntegration\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * 代充失败补偿台账。
 */
class KcCompensation extends Model
{
    protected $table = 'v2_plugin_kc_compensations';

    protected $guarded = ['id'];

    protected $casts = [
        'order_id' => 'integer',
        'user_id' => 'integer',
        'amount' => 'integer',
        'balance_amount' => 'integer',
        'external_amount' => 'integer',
        'handling_amount' => 'integer',
        'balance_before' => 'integer',
        'balance_after' => 'integer',
        'attempts' => 'integer',
        'balance_refunded_at' => 'datetime',
        'processed_at' => 'datetime',
    ];

    public const STATUS_PROCESSING = 'processing';
    public const STATUS_BALANCE_REFUNDED = 'balance_refunded';
    public const STATUS_MANUAL_PENDING = 'manual_pending';
    public const STATUS_PARTIAL_MANUAL_PENDING = 'partial_refunded_manual_pending';
    public const STATUS_MANUAL_DONE = 'manual_done';
    public const STATUS_REVIEW_PENDING = 'review_pending';
    public const STATUS_FAILED = 'failed';

    public static array $statusMap = [
        self::STATUS_PROCESSING => '补偿处理中',
        self::STATUS_BALANCE_REFUNDED => '已退回余额',
        self::STATUS_MANUAL_PENDING => '待人工退款',
        self::STATUS_PARTIAL_MANUAL_PENDING => '余额已退，外部支付待处理',
        self::STATUS_MANUAL_DONE => '人工退款已处理',
        self::STATUS_REVIEW_PENDING => '结果待确认',
        self::STATUS_FAILED => '补偿处理异常',
    ];

    public function isFinal(): bool
    {
        return in_array($this->status, [
            self::STATUS_BALANCE_REFUNDED,
            self::STATUS_MANUAL_PENDING,
            self::STATUS_PARTIAL_MANUAL_PENDING,
            self::STATUS_MANUAL_DONE,
            self::STATUS_REVIEW_PENDING,
        ], true);
    }

    /**
     * 用户可见数据：不暴露供应商原始错误、操作人或后台备注。
     */
    public function toPublicPayload(): array
    {
        return [
            'trade_no' => (string) $this->trade_no,
            'status' => (string) $this->status,
            'status_cn' => self::$statusMap[$this->status] ?? '处理中',
            'amount' => (int) $this->amount,
            'balance_amount' => (int) $this->balance_amount,
            'external_amount' => (int) $this->external_amount,
            'reason_label' => '代充未完成',
            'updated_at' => $this->updated_at?->timestamp,
        ];
    }
}
