<?php

namespace Plugin\KcIntegration\Models;

use Illuminate\Database\Eloquent\Model;

/** S9 售后主记录。 */
class KcAfterSales extends Model
{
    protected $table = 'v2_plugin_kc_after_sales';
    protected $guarded = ['id'];
    protected $casts = ['order_id' => 'integer', 'user_id' => 'integer', 'processed_at' => 'datetime'];

    public const TYPE_FAILED = 'failed';
    public const TYPE_TIMEOUT = 'timeout';
    public const TYPE_REFUND = 'refund';
    public const TYPE_OTHER = 'other';
    public const STATUS_PENDING = 'pending';
    public const STATUS_REVIEWING = 'reviewing';
    public const STATUS_APPROVED = 'approved';
    public const STATUS_REJECTED = 'rejected';
    public const STATUS_RESOLVED = 'resolved';
    public const STATUS_CANCELLED = 'cancelled';

    public static array $typeMap = [
        self::TYPE_FAILED => '代充失败', self::TYPE_TIMEOUT => '长时间未完成',
        self::TYPE_REFUND => '退款申请', self::TYPE_OTHER => '其他订单问题',
    ];
    public static array $statusMap = [
        self::STATUS_PENDING => '待处理', self::STATUS_REVIEWING => '处理中',
        self::STATUS_APPROVED => '已受理', self::STATUS_REJECTED => '已驳回',
        self::STATUS_RESOLVED => '已完成', self::STATUS_CANCELLED => '已取消',
    ];

    public function isOpen(): bool
    {
        return in_array((string) $this->status, [self::STATUS_PENDING, self::STATUS_REVIEWING, self::STATUS_APPROVED], true);
    }

    public function isFinal(): bool
    {
        return in_array((string) $this->status, [self::STATUS_REJECTED, self::STATUS_RESOLVED, self::STATUS_CANCELLED], true);
    }

    public function toPublicPayload(array $messages = []): array
    {
        $payload = [
            'request_no' => (string) $this->request_no,
            'trade_no' => (string) $this->trade_no,
            'request_type' => (string) $this->request_type,
            'request_type_cn' => self::$typeMap[$this->request_type] ?? '订单问题',
            'status' => (string) $this->status,
            'status_cn' => self::$statusMap[$this->status] ?? '处理中',
            'user_message' => (string) $this->user_message,
            'resolution' => (string) $this->resolution,
            'created_at' => $this->created_at?->timestamp,
            'updated_at' => $this->updated_at?->timestamp,
            'processed_at' => $this->processed_at?->timestamp,
        ];
        if ($messages) $payload['messages'] = $messages;
        return $payload;
    }
}
