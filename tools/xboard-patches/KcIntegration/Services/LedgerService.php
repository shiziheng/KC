<?php

namespace Plugin\KcIntegration\Services;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Plugin\KcIntegration\Models\KcLedger;

/**
 * S6 账务流水服务。
 *
 * 所有写入都以 event_key 唯一约束做最终幂等裁决；调用方应在余额变更的
 * 同一数据库事务内调用本服务，流水失败就让余额变更一起回滚。
 */
class LedgerService
{
    private const TYPES = [
        KcLedger::TYPE_TOPUP,
        KcLedger::TYPE_ORDER_DEBIT,
        KcLedger::TYPE_COMPENSATION_CREDIT,
        KcLedger::TYPE_MANUAL_ADJUSTMENT,
    ];

    /**
     * 写入一条流水。重复 event_key 返回 false（不重复入账），不会抛异常。
     */
    public function record(
        string $eventKey,
        int $userId,
        string $type,
        int $amount,
        int $before,
        int $after,
        ?string $tradeNo = null,
        ?int $orderId = null,
        string $source = 'system',
        string $operatorRef = 'system',
        array $metadata = []
    ): bool {
        if ($eventKey === '' || $userId <= 0 || !in_array($type, self::TYPES, true) || $amount === 0) {
            throw new \InvalidArgumentException('账务流水参数不完整');
        }

        $affected = DB::affectingStatement(
            'INSERT IGNORE INTO `v2_plugin_kc_ledger`
                (`event_key`, `user_id`, `order_id`, `trade_no`, `type`, `amount`,
                 `balance_before`, `balance_after`, `source`, `operator_ref`, `metadata`, `created_at`, `updated_at`)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                substr($eventKey, 0, 128),
                $userId,
                $orderId,
                $tradeNo !== null && $tradeNo !== '' ? substr($tradeNo, 0, 36) : null,
                $type,
                $amount,
                $before,
                $after,
                substr($source !== '' ? $source : 'system', 0, 64),
                substr($operatorRef !== '' ? $operatorRef : 'system', 0, 191),
                $metadata !== [] ? json_encode($metadata, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
                now(),
                now(),
            ]
        );

        return $affected === 1;
    }

    /** 在 order.create.after 中记录核心余额扣款。 */
    public function recordOrderDebit(\App\Models\Order $order): bool
    {
        $amount = max(0, (int) ($order->balance_amount ?? 0));
        if ($amount <= 0) return false;

        $user = User::lockForUpdate()->find((int) $order->user_id);
        if (!$user) throw new \RuntimeException('账务扣款用户不存在');
        $after = (int) $user->balance;
        $before = $after + $amount;

        return $this->record(
            'order-debit:' . (string) $order->trade_no,
            (int) $order->user_id,
            KcLedger::TYPE_ORDER_DEBIT,
            -$amount,
            $before,
            $after,
            (string) $order->trade_no,
            (int) $order->id,
            'order.create.after'
        );
    }

    /** 用户只读流水，按最新优先。 */
    public function listForUser(int $userId, int $limit = 50): array
    {
        return KcLedger::where('user_id', $userId)
            ->orderByDesc('id')
            ->limit(max(1, min(100, $limit)))
            ->get()
            ->map(fn (KcLedger $row) => $row->toPublicPayload())
            ->all();
    }

    /**
     * 用首条流水的期初余额 + 全部流水复算当前余额。
     * 没有流水时返回 not_enough_data，不生成历史假流水。
     */
    public function reconcileUser(int $userId): array
    {
        $user = User::find($userId);
        if (!$user) return ['status' => 'user_missing', 'current_balance' => 0, 'expected_balance' => null, 'difference' => null];

        $first = KcLedger::where('user_id', $userId)->orderBy('id')->first();
        if (!$first) {
            return [
                'status' => 'not_enough_data',
                'current_balance' => (int) $user->balance,
                'expected_balance' => null,
                'difference' => null,
            ];
        }

        $sum = (int) KcLedger::where('user_id', $userId)->sum('amount');
        $expected = (int) $first->balance_before + $sum;
        $current = (int) $user->balance;

        return [
            'status' => $expected === $current ? 'matched' : 'mismatch',
            'current_balance' => $current,
            'opening_balance' => (int) $first->balance_before,
            'total_ledger_amount' => $sum,
            'expected_balance' => $expected,
            'difference' => $current - $expected,
        ];
    }

    public function listForAdmin(?int $userId = null, ?string $tradeNo = null, ?string $type = null, int $limit = 100): array
    {
        $query = KcLedger::query()->orderByDesc('id')->limit(max(1, min(200, $limit)));
        if ($userId !== null && $userId > 0) $query->where('user_id', $userId);
        if ($tradeNo !== null && $tradeNo !== '') $query->where('trade_no', substr($tradeNo, 0, 36));
        if ($type !== null && $type !== '' && in_array($type, self::TYPES, true)) $query->where('type', $type);
        return $query->get()->map(fn (KcLedger $row) => array_merge($row->toPublicPayload(), [
            'user_id' => (int) $row->user_id,
            'order_id' => $row->order_id !== null ? (int) $row->order_id : null,
        ]))->all();
    }
}
