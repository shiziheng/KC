<?php

namespace Plugin\KcIntegration\Services;

use App\Models\Order;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Plugin\KcIntegration\Models\KcCompensation;
use Plugin\KcIntegration\Models\KcLedger;

/**
 * 代充失败补偿服务（FEAT-018 S4）。
 *
 * 规则：
 * - 纯余额支付：在同一事务里把 balance_amount 退回一次；
 * - 纯外部支付：建立待人工退款，不伪造已退款；
 * - 混合支付：先退回余额部分，外部支付部分进入人工退款；
 * - 结果不确定或订单未实际支付：只进入待确认，不自动动余额。
 */
class CompensationService
{
    /**
     * 为一个已确认失败的代充订单建立/完成补偿。
     * 同一 trade_no 可被状态轮询、重复回调和后台重试多次调用。
     *
     * @return array{ok:bool, skipped:bool, error:string, compensation:?KcCompensation}
     */
    public function handleTerminalFailure(Order $order, string $reasonCode = 'kc_task_failed', string $reason = 'KC 代充任务失败'): array
    {
        $tradeNo = trim((string) $order->trade_no);
        if ($tradeNo === '' || (int) $order->user_id <= 0) {
            return ['ok' => false, 'skipped' => false, 'error' => '订单信息不完整', 'compensation' => null];
        }

        $amounts = $this->resolveAmounts($order);
        $idempotencyKey = 'kc-failure:' . $tradeNo;

        try {
            // 先占位，唯一键裁决并发请求；冲突时仍进入 complete()，由行锁读取最终状态。
            $inserted = DB::affectingStatement(
                'INSERT IGNORE INTO `v2_plugin_kc_compensations`
                    (`trade_no`, `idempotency_key`, `order_id`, `user_id`, `compensation_type`, `status`,
                     `amount`, `balance_amount`, `external_amount`, `handling_amount`, `reason_code`, `reason`,
                     `operator_ref`, `note`, `attempts`, `created_at`, `updated_at`)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
                [
                    $tradeNo,
                    $idempotencyKey,
                    (int) $order->id,
                    (int) $order->user_id,
                    $amounts['type'],
                    KcCompensation::STATUS_PROCESSING,
                    $amounts['amount'],
                    $amounts['balance_amount'],
                    $amounts['external_amount'],
                    $amounts['handling_amount'],
                    substr($reasonCode, 0, 64),
                    substr($reason, 0, 255),
                    'system',
                    '',
                    now(),
                    now(),
                ]
            );

            if ($inserted !== 1) {
                KcCompensation::where('trade_no', $tradeNo)->increment('attempts');
            }

            return $this->complete($tradeNo);
        } catch (\Throwable $e) {
            Log::channel('daily')->error('[KcIntegration] 补偿占位失败: ' . $e->getMessage(), [
                'trade_no' => $tradeNo,
                'reason_code' => substr($reasonCode, 0, 64),
            ]);
            return ['ok' => false, 'skipped' => false, 'error' => '补偿记录创建失败', 'compensation' => null];
        }
    }

    protected function complete(string $tradeNo): array
    {
        try {
            $result = DB::transaction(function () use ($tradeNo) {
                $row = KcCompensation::where('trade_no', $tradeNo)->lockForUpdate()->first();
                if (!$row) {
                    throw new \RuntimeException('补偿记录不存在');
                }

                if ($row->isFinal()) {
                    return ['skipped' => true, 'row' => $row];
                }

                $order = Order::whereKey($row->order_id)->lockForUpdate()->first();
                if (!$order) {
                    throw new \RuntimeException('原订单不存在');
                }

                if (in_array((int) $order->status, [Order::STATUS_PENDING, Order::STATUS_CANCELLED], true)) {
                    $row->status = KcCompensation::STATUS_REVIEW_PENDING;
                    $row->note = '原订单未处于已支付履约状态，需人工核对';
                    $row->processed_at = now();
                    $row->save();
                    return ['skipped' => false, 'row' => $row];
                }

                $before = 0;
                $after = 0;
                if ((int) $row->balance_amount > 0) {
                    $user = User::whereKey($row->user_id)->lockForUpdate()->first();
                    if (!$user) {
                        throw new \RuntimeException('补偿用户不存在');
                    }

                    $before = (int) $user->balance;
                    $after = $before + (int) $row->balance_amount;
                    $user->balance = $after;
                    if (!$user->save()) {
                        throw new \RuntimeException('余额退回失败');
                    }
                }

                if ((int) $row->external_amount > 0 && (int) $row->balance_amount > 0) {
                    $status = KcCompensation::STATUS_PARTIAL_MANUAL_PENDING;
                } elseif ((int) $row->external_amount > 0) {
                    $status = KcCompensation::STATUS_MANUAL_PENDING;
                } elseif ((int) $row->balance_amount > 0) {
                    $status = KcCompensation::STATUS_BALANCE_REFUNDED;
                } else {
                    $status = KcCompensation::STATUS_REVIEW_PENDING;
                }

                $row->balance_before = $before;
                $row->balance_after = $after;
                $row->status = $status;
                if ($before !== $after) {
                    $row->balance_refunded_at = now();
                }
                if ($status === KcCompensation::STATUS_BALANCE_REFUNDED || $status === KcCompensation::STATUS_REVIEW_PENDING) {
                    $row->processed_at = now();
                }
                $row->save();

                // 只有实际退回用户余额的部分进入补偿流水；外部支付仍由人工退款队列处理。
                if ((int) $row->balance_amount > 0) {
                    (new LedgerService())->record(
                        'compensation-credit:' . (string) $row->trade_no,
                        (int) $row->user_id,
                        KcLedger::TYPE_COMPENSATION_CREDIT,
                        (int) $row->balance_amount,
                        $before,
                        $after,
                        (string) $row->trade_no,
                        (int) $row->order_id,
                        'compensation.failure'
                    );
                }

                return ['skipped' => false, 'row' => $row];
            });

            $row = $result['row'];
            return ['ok' => true, 'skipped' => (bool) $result['skipped'], 'error' => '', 'compensation' => $row];
        } catch (\Throwable $e) {
            KcCompensation::where('trade_no', $tradeNo)
                ->whereNotIn('status', [
                    KcCompensation::STATUS_BALANCE_REFUNDED,
                    KcCompensation::STATUS_MANUAL_PENDING,
                    KcCompensation::STATUS_PARTIAL_MANUAL_PENDING,
                    KcCompensation::STATUS_MANUAL_DONE,
                    KcCompensation::STATUS_REVIEW_PENDING,
                ])
                ->update([
                    'status' => KcCompensation::STATUS_FAILED,
                    'reason' => '补偿事务失败，等待重试',
                    'updated_at' => now(),
                ]);
            Log::channel('daily')->error('[KcIntegration] 补偿事务失败: ' . $e->getMessage(), [
                'trade_no' => $tradeNo,
            ]);
            return ['ok' => false, 'skipped' => false, 'error' => '补偿事务失败，请联系客服', 'compensation' => $this->find($tradeNo)];
        }
    }

    public function markManualDone(string $tradeNo, string $operatorRef, string $note = ''): array
    {
        try {
            $row = DB::transaction(function () use ($tradeNo, $operatorRef, $note) {
                $row = KcCompensation::where('trade_no', $tradeNo)->lockForUpdate()->first();
                if (!$row) {
                    throw new \RuntimeException('补偿记录不存在');
                }
                if ($row->status === KcCompensation::STATUS_MANUAL_DONE) {
                    return $row;
                }
                if (!in_array($row->status, [
                    KcCompensation::STATUS_MANUAL_PENDING,
                    KcCompensation::STATUS_PARTIAL_MANUAL_PENDING,
                ], true)) {
                    throw new \RuntimeException('当前补偿状态不允许标记人工退款完成');
                }

                $row->status = KcCompensation::STATUS_MANUAL_DONE;
                $row->operator_ref = substr($operatorRef !== '' ? $operatorRef : 'admin', 0, 191);
                $row->note = substr($note, 0, 500);
                $row->processed_at = now();
                $row->save();
                return $row;
            });

            return ['ok' => true, 'skipped' => false, 'error' => '', 'compensation' => $row];
        } catch (\Throwable $e) {
            return ['ok' => false, 'skipped' => false, 'error' => $e->getMessage(), 'compensation' => $this->find($tradeNo)];
        }
    }

    public function find(string $tradeNo): ?KcCompensation
    {
        return KcCompensation::where('trade_no', $tradeNo)->first();
    }

    public function listForUser(int $userId, int $limit = 50): array
    {
        if ($userId <= 0) {
            return [];
        }
        return KcCompensation::where('user_id', $userId)
            ->orderByDesc('created_at')
            ->limit(max(1, min(100, $limit)))
            ->get()
            ->map(fn (KcCompensation $row) => $row->toPublicPayload())
            ->all();
    }

    public function listForAdmin(?string $status = null, int $limit = 100): array
    {
        $query = KcCompensation::query()->orderByDesc('created_at')->limit(max(1, min(200, $limit)));
        if ($status !== null && $status !== '') {
            $query->where('status', substr($status, 0, 48));
        }
        return $query->get()->map(fn (KcCompensation $row) => [
            'trade_no' => (string) $row->trade_no,
            'order_id' => (int) $row->order_id,
            'user_id' => (int) $row->user_id,
            'type' => (string) $row->compensation_type,
            'status' => (string) $row->status,
            'status_cn' => KcCompensation::$statusMap[$row->status] ?? $row->status,
            'amount' => (int) $row->amount,
            'balance_amount' => (int) $row->balance_amount,
            'external_amount' => (int) $row->external_amount,
            'handling_amount' => (int) $row->handling_amount,
            'reason_code' => (string) $row->reason_code,
            'reason' => (string) $row->reason,
            'operator_ref' => (string) $row->operator_ref,
            'note' => (string) $row->note,
            'attempts' => (int) $row->attempts,
            'created_at' => $row->created_at?->timestamp,
            'processed_at' => $row->processed_at?->timestamp,
        ])->all();
    }

    protected function resolveAmounts(Order $order): array
    {
        $balanceAmount = max(0, (int) ($order->balance_amount ?? 0));
        $externalAmount = max(0, (int) ($order->total_amount ?? 0));
        $handlingAmount = max(0, (int) ($order->handling_amount ?? 0));
        $type = $balanceAmount > 0 && $externalAmount > 0
            ? 'mixed'
            : ($balanceAmount > 0 ? 'balance' : ($externalAmount > 0 ? 'external' : 'review'));

        return [
            'type' => $type,
            'balance_amount' => $balanceAmount,
            'external_amount' => $externalAmount,
            'handling_amount' => $handlingAmount,
            'amount' => $balanceAmount + $externalAmount,
        ];
    }
}
