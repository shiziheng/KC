<?php

namespace Plugin\KcIntegration\Services;

use App\Models\Plan;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Plugin\KcIntegration\Models\KcTopup;

/**
 * 充值服务（FEAT-004 · D2）
 *
 * 职责：把一笔「充值套餐订单」转成「用户余额增加」。
 *
 * ⚠️ 幂等是本模块的**唯一关键**，因为重复加钱 = 直接资损。
 *
 * 为什么不能"先查后写"：
 *     if (!exists($tradeNo)) { addBalance(); }   ← 并发下两个请求都能通过 exists 检查
 *
 * 正确做法是**先占位、再执行**，用数据库 UNIQUE 约束做裁决：
 *     INSERT IGNORE INTO v2_plugin_kc_topups (trade_no, ...) VALUES (...)
 *     → affectedRows === 1 才继续；=== 0 说明别人已经在处理，直接放弃
 *
 * ⚠️ 为什么是 INSERT IGNORE 而不是 ON DUPLICATE KEY UPDATE：
 *    段C1 实测过 —— mysql2/PHP 下 ON DUPLICATE KEY UPDATE 冲突时 affectedRows 仍返回 1，
 *    用它做并发裁决会**超发**。必须用 INSERT IGNORE（冲突时 affectedRows=0）。
 */
class TopupService
{
    /**
     * 判断该套餐是否为充值套餐。
     */
    public function isTopupPlan(int $planId): bool
    {
        if ($planId <= 0) {
            return false;
        }

        return (int) (Plan::where('id', $planId)->value('kc_is_topup') ?? 0) === 1;
    }

    /**
     * 取套餐配置的到账金额（分）。
     */
    public function resolveAmount(int $planId): int
    {
        return max(0, (int) (Plan::where('id', $planId)->value('kc_topup_amount') ?? 0));
    }

    /**
     * 执行充值（幂等）。
     *
     * @return array{ok: bool, skipped: bool, amount: int, error: string}
     *         skipped=true 表示「本次无需处理」（已有记录），不是错误
     */
    public function apply(string $tradeNo, int $userId, int $amount, string $source = 'webhook', string $operatorRef = 'system', array $metadata = []): array
    {
        if ($tradeNo === '' || $userId <= 0) {
            return ['ok' => false, 'skipped' => false, 'amount' => 0, 'error' => '参数不完整'];
        }

        if ($amount <= 0) {
            return ['ok' => false, 'skipped' => false, 'amount' => 0, 'error' => '充值金额未配置'];
        }

        // ── 步骤 1：占位（原子裁决）
        // 这里用原生 SQL 而非 Eloquent，确保拿到真实的 affectedRows。
        $inserted = $this->tryOccupy($tradeNo, $userId, $amount);

        if (!$inserted) {
            // 已有占位记录 —— 说明这笔订单已经被处理过（或正在处理）。
            // 累加 attempts 便于对账时看出被重复触发了多少次。
            KcTopup::where('trade_no', $tradeNo)->increment('attempts');

            $row = KcTopup::where('trade_no', $tradeNo)->first();
            if (!$row) {
                return ['ok' => false, 'skipped' => false, 'amount' => 0, 'error' => '充值记录不可用，请稍后重试'];
            }
            if ($row && $row->status === KcTopup::STATUS_DONE) {
                // 已成功过，直接返回成功（调用方无需区分）
                return ['ok' => true, 'skipped' => true, 'amount' => (int) $row->amount, 'error' => ''];
            }
            if ($row && $row->status === KcTopup::STATUS_PENDING) {
                // 占位了但没完成 —— 可能是上次处理到一半崩了，这里重试
                return $this->complete($row, $source, $operatorRef, $metadata);
            }

            // failed 状态：允许重试
            return $this->complete($row, $source, $operatorRef, $metadata);
        }

        // ── 步骤 2：执行加钱
        $row = KcTopup::where('trade_no', $tradeNo)->first();
        if (!$row) {
            return ['ok' => false, 'skipped' => false, 'amount' => 0, 'error' => '占位记录丢失'];
        }

        return $this->complete($row, $source, $operatorRef, $metadata);
    }

    /**
     * 生成订单级 USDT 支付识别信息。
     *
     * TRC20 转账通常没有可靠商户备注，因此使用两位最小单位尾数区分订单。
     * 尾数只用于匹配，实际增加余额仍使用套餐的 amount。
     */
    public static function paymentDetails(int $amount, string $tradeNo): array
    {
        $hash = hash('sha256', $tradeNo);
        $suffix = (hexdec(substr($hash, 0, 4)) % 90) + 10;
        return [
            'payment_reference' => 'KC' . strtoupper(substr($hash, 0, 12)),
            'expected_amount' => max(0, $amount) + $suffix,
            'suffix' => $suffix,
            'chain' => 'TRC20',
        ];
    }

    /** 在支付跳转前占位，保证回调/人工补单共用同一行幂等记录。 */
    public function ensurePaymentDraft(string $tradeNo, int $userId, int $amount, ?int $expectedAmount = null, ?string $paymentReference = null, array $meta = []): void
    {
        if ($tradeNo === '' || $userId <= 0 || $amount <= 0) return;
        $details = self::paymentDetails($amount, $tradeNo);
        $expectedAmount = $expectedAmount ?? $details['expected_amount'];
        $paymentReference = $paymentReference ?: $details['payment_reference'];
        $chain = strtoupper(trim((string) ($meta['chain'] ?? $details['chain']))) ?: $details['chain'];
        $wallet = trim((string) ($meta['wallet_address'] ?? ''));
        DB::statement(
            'INSERT IGNORE INTO `v2_plugin_kc_topups`
             (`trade_no`, `user_id`, `amount`, `balance_before`, `balance_after`, `status`, `error_msg`, `attempts`, `expires_at`, `paid_at`, `payment_method`, `payment_reference`, `expected_amount`, `received_amount`, `chain`, `wallet_address`, `match_status`, `payment_source`, `created_at`, `updated_at`)
             VALUES (?, ?, ?, 0, 0, ?, \'\', 0, ?, NULL, \'usdt\', ?, ?, 0, ?, ?, \'pending\', \'checkout\', ?, ?)',
            [$tradeNo, $userId, $amount, KcTopup::STATUS_PENDING, time() + 1800, $paymentReference, $expectedAmount, $chain, $wallet !== '' ? substr($wallet, 0, 128) : null, now(), now()]
        );
    }

    /** 保存钱包/人工核验结果，不直接变更余额。 */
    public function markPayment(string $tradeNo, int $receivedAmount, string $txHash, int $confirmations, string $matchStatus, string $source, string $reason = '', string $operatorRef = 'system'): ?KcTopup
    {
        $row = $this->find($tradeNo);
        if (!$row) return null;
        $row->received_amount = max(0, $receivedAmount);
        $row->tx_hash = $txHash !== '' ? substr($txHash, 0, 128) : null;
        $row->confirmations = max(0, $confirmations);
        $row->match_status = substr($matchStatus !== '' ? $matchStatus : 'manual_review', 0, 32);
        $row->payment_source = substr($source !== '' ? $source : 'manual', 0, 32);
        $row->manual_reason = $reason !== '' ? substr($reason, 0, 500) : null;
        $row->operator_ref = $operatorRef !== '' ? substr($operatorRef, 0, 191) : null;
        $row->save();
        return $row->fresh();
    }

    /**
     * 尝试占位。返回 true 表示本次是**第一个**处理者。
     *
     * ⚠️ 必须用 INSERT IGNORE（冲突时 affectedRows=0）做并发裁决，理由见类注释。
     *
     * FEAT-014：同时写入 expires_at（订单失效时间戳）。
     *   台账行是在**支付成功回调**时创建的，此时订单已经付完钱了，
     *   expires_at 实际只用于「历史对账 / 展示到账时长」；
     *   真正的下单有效期由 TopupController::orders() 按 v2_order.created_at + TTL 推算，
     *   避免「未支付订单没有台账行 → 有效期无从判断」的问题。
     */
    protected function tryOccupy(string $tradeNo, int $userId, int $amount): bool
    {
        $now = now();
        $details = self::paymentDetails($amount, $tradeNo);

        $affected = DB::affectingStatement(
            'INSERT IGNORE INTO `v2_plugin_kc_topups`
                (`trade_no`, `user_id`, `amount`, `balance_before`, `balance_after`, `status`, `error_msg`, `attempts`, `created_at`, `updated_at`, `paid_at`, `payment_method`, `payment_reference`, `expected_amount`, `chain`, `match_status`, `payment_source`)
             VALUES (?, ?, ?, 0, 0, ?, \'\', 1, ?, ?, ?, \'usdt\', ?, ?, ?, \'pending\', \'webhook\')',
            [$tradeNo, $userId, $amount, KcTopup::STATUS_PENDING, $now, $now, time(), $details['payment_reference'], $details['expected_amount'], $details['chain']]
        );

        return $affected === 1;
    }

    /**
     * 真正加钱 + 标记完成。
     *
     * 加钱与状态更新放在同一事务里，失败一起回滚。
     */
    protected function complete(KcTopup $row, string $source = 'webhook', string $operatorRef = 'system', array $metadata = []): array
    {
        try {
            $result = DB::transaction(function () use ($row, $source, $operatorRef, $metadata) {
                // 必须先锁充值台账行，再锁用户行。否则两个并发回调都可能在
                // 各自读取到 pending 后重复给同一用户加钱。
                $lockedRow = KcTopup::where('id', $row->id)->lockForUpdate()->first();
                if (!$lockedRow) {
                    throw new \RuntimeException('充值记录不存在: ' . $row->trade_no);
                }

                // 另一请求已经完成时，本次只返回幂等成功，绝不再次改余额。
                if ($lockedRow->status === KcTopup::STATUS_DONE) {
                    return [
                        'already' => true,
                        'trade_no' => $lockedRow->trade_no,
                        'user_id' => (int) $lockedRow->user_id,
                        'amount' => (int) $lockedRow->amount,
                        'before' => (int) $lockedRow->balance_before,
                        'after' => (int) $lockedRow->balance_after,
                    ];
                }

                $user = User::lockForUpdate()->find($lockedRow->user_id);
                if (!$user) {
                    throw new \RuntimeException('用户不存在: ' . $lockedRow->user_id);
                }

                $before = (int) $user->balance;
                $after  = $before + (int) $lockedRow->amount;

                $user->balance = $after;
                if (!$user->save()) {
                    throw new \RuntimeException('余额写入失败');
                }

                $lockedRow->balance_before = $before;
                $lockedRow->balance_after  = $after;
                $lockedRow->status         = KcTopup::STATUS_DONE;
                $lockedRow->error_msg      = '';
                $lockedRow->match_status   = 'credited';
                $lockedRow->payment_source = $source !== '' ? substr($source, 0, 32) : 'webhook';
                if ($operatorRef !== '' && $operatorRef !== 'system') {
                    $lockedRow->operator_ref = substr($operatorRef, 0, 191);
                }
                $lockedRow->save();

                // 充值余额与流水必须同事务提交；流水失败会让本次加钱回滚。
                (new LedgerService())->record(
                    'topup:' . (string) $lockedRow->trade_no,
                    (int) $lockedRow->user_id,
                    \Plugin\KcIntegration\Models\KcLedger::TYPE_TOPUP,
                    (int) $lockedRow->amount,
                    $before,
                    $after,
                    (string) $lockedRow->trade_no,
                    null,
                    $source === 'manual' ? 'topup.manual' : 'topup.payment',
                    $operatorRef,
                    $metadata
                );

                return [
                    'already' => false,
                    'trade_no' => $lockedRow->trade_no,
                    'user_id' => (int) $lockedRow->user_id,
                    'amount' => (int) $lockedRow->amount,
                    'before' => $before,
                    'after' => $after,
                ];
            });

            if ($result['already']) {
                return [
                    'ok' => true,
                    'skipped' => true,
                    'amount' => (int) $result['amount'],
                    'error' => '',
                ];
            }

            Log::channel('daily')->info('[KcIntegration] 充值到账', [
                'trade_no' => $result['trade_no'],
                'user_id'  => $result['user_id'],
                'amount'   => $result['amount'],
                'before'   => $result['before'],
                'after'    => $result['after'],
            ]);

            return ['ok' => true, 'skipped' => false, 'amount' => (int) $result['amount'], 'error' => ''];
        } catch (\Throwable $e) {
            // 标记失败，允许下次重试。**绝不能**吞掉异常后还标 done。
            try {
                $row->status    = KcTopup::STATUS_FAILED;
                $row->error_msg = mb_substr($e->getMessage(), 0, 500);
                $row->save();
            } catch (\Throwable $ignored) {
            }

            Log::channel('daily')->error('[KcIntegration] 充值失败: ' . $e->getMessage(), [
                'trade_no' => $row->trade_no,
            ]);

            return ['ok' => false, 'skipped' => false, 'amount' => 0, 'error' => $e->getMessage()];
        }
    }

    /**
     * 查询某订单的充值记录（前台展示用）。
     */
    public function find(string $tradeNo): ?KcTopup
    {
        return KcTopup::where('trade_no', $tradeNo)->first();
    }
}
