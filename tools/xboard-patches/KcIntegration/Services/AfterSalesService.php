<?php

namespace Plugin\KcIntegration\Services;

use App\Models\Order;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Plugin\KcIntegration\Models\KcAfterSales;

/** S9 售后申请服务；退款只通过 S4 CompensationService 处理。 */
class AfterSalesService
{
    public const VALID_TYPES = [KcAfterSales::TYPE_FAILED, KcAfterSales::TYPE_TIMEOUT, KcAfterSales::TYPE_REFUND, KcAfterSales::TYPE_OTHER];

    public function createForUser(Order $order, int $userId, string $type, string $message): array
    {
        $tradeNo = trim((string) $order->trade_no);
        $type = trim($type);
        $message = $this->cleanText($message, 1000);
        if ($tradeNo === '' || $userId <= 0 || (int) $order->user_id !== $userId) return ['ok' => false, 'error' => '订单不存在或无权申请售后', 'request' => null];
        if (!in_array($type, self::VALID_TYPES, true)) return ['ok' => false, 'error' => '售后类型不正确', 'request' => null];
        if ($message === '') return ['ok' => false, 'error' => '请填写问题说明', 'request' => null];
        if (in_array((int) $order->status, [0, 2], true)) return ['ok' => false, 'error' => '订单尚未完成支付，暂不能申请售后', 'request' => null];
        $existing = KcAfterSales::where('trade_no', $tradeNo)->first();
        if ($existing) return ['ok' => false, 'error' => '该订单已有售后申请，请在原申请中补充说明', 'request' => $existing];
        try {
            $request = DB::transaction(function () use ($order, $userId, $type, $message, $tradeNo) {
                $row = new KcAfterSales();
                $row->request_no = $this->newRequestNo(); $row->trade_no = $tradeNo; $row->order_id = (int) $order->id;
                $row->user_id = $userId; $row->request_type = $type; $row->status = KcAfterSales::STATUS_PENDING; $row->user_message = $message; $row->save();
                $this->addMessageRow($row, 'user', 'user:' . $userId, $message); return $row;
            });
            return ['ok' => true, 'error' => '', 'request' => $request];
        } catch (QueryException $e) {
            return ['ok' => false, 'error' => '该订单已有售后申请，请在原申请中补充说明', 'request' => KcAfterSales::where('trade_no', $tradeNo)->first()];
        } catch (\Throwable $e) {
            Log::channel('daily')->error('[KcIntegration] 创建售后申请失败: ' . $e->getMessage(), ['trade_no' => $tradeNo]);
            return ['ok' => false, 'error' => '售后申请创建失败，请稍后重试', 'request' => null];
        }
    }

    public function addUserMessage(string $requestNo, int $userId, string $message): array
    {
        $message = $this->cleanText($message, 1000);
        if ($message === '') return ['ok' => false, 'error' => '补充说明不能为空', 'request' => null];
        try {
            $row = DB::transaction(function () use ($requestNo, $userId, $message) {
                $row = KcAfterSales::where('request_no', trim($requestNo))->lockForUpdate()->first();
                if (!$row || (int) $row->user_id !== $userId) throw new \RuntimeException('售后申请不存在或无权访问');
                if (!$row->isOpen()) throw new \RuntimeException('当前售后申请已结束，不能继续补充');
                $this->addMessageRow($row, 'user', 'user:' . $userId, $message);
                $row->user_message = $this->cleanText(trim((string) $row->user_message . "\n" . $message), 1000); $row->save(); return $row;
            });
            return ['ok' => true, 'error' => '', 'request' => $row];
        } catch (\Throwable $e) { return ['ok' => false, 'error' => $e->getMessage(), 'request' => $this->findByUser($requestNo, $userId)]; }
    }

    public function cancelForUser(string $requestNo, int $userId): array
    {
        try {
            $row = DB::transaction(function () use ($requestNo, $userId) {
                $row = KcAfterSales::where('request_no', trim($requestNo))->lockForUpdate()->first();
                if (!$row || (int) $row->user_id !== $userId) throw new \RuntimeException('售后申请不存在或无权访问');
                if ($row->status !== KcAfterSales::STATUS_PENDING) throw new \RuntimeException('当前状态不能取消');
                $row->status = KcAfterSales::STATUS_CANCELLED; $row->processed_at = now(); $row->resolution = '用户取消申请'; $row->save();
                $this->addMessageRow($row, 'system', 'system', '用户取消了售后申请'); return $row;
            });
            return ['ok' => true, 'error' => '', 'request' => $row];
        } catch (\Throwable $e) { return ['ok' => false, 'error' => $e->getMessage(), 'request' => $this->findByUser($requestNo, $userId)]; }
    }

    public function process(string $requestNo, string $action, string $operatorRef, string $note = '', bool $refund = false): array
    {
        $action = trim($action); $note = $this->cleanText($note, 500); $row = KcAfterSales::where('request_no', trim($requestNo))->first();
        if (!$row) return ['ok' => false, 'error' => '售后申请不存在', 'request' => null, 'compensation' => null];
        $nextStatus = ['review' => KcAfterSales::STATUS_REVIEWING, 'approve' => KcAfterSales::STATUS_APPROVED, 'reject' => KcAfterSales::STATUS_REJECTED, 'resolve' => KcAfterSales::STATUS_RESOLVED][$action] ?? null;
        if ($nextStatus === null) return ['ok' => false, 'error' => '处理动作不正确', 'request' => $row, 'compensation' => null];
        if ($row->isFinal() && $row->status !== $nextStatus) return ['ok' => false, 'error' => '当前售后申请已结束，不能重复处理', 'request' => $row, 'compensation' => null];
        $allowedStatuses = ['review' => [KcAfterSales::STATUS_PENDING, KcAfterSales::STATUS_REVIEWING], 'approve' => [KcAfterSales::STATUS_PENDING, KcAfterSales::STATUS_REVIEWING, KcAfterSales::STATUS_APPROVED], 'reject' => [KcAfterSales::STATUS_PENDING, KcAfterSales::STATUS_REVIEWING, KcAfterSales::STATUS_APPROVED], 'resolve' => [KcAfterSales::STATUS_REVIEWING, KcAfterSales::STATUS_APPROVED]];
        if (!in_array($row->status, $allowedStatuses[$action] ?? [], true)) return ['ok' => false, 'error' => '当前状态不允许此处理动作', 'request' => $row, 'compensation' => null];
        if ($action === 'reject' && $note === '') return ['ok' => false, 'error' => '驳回时必须填写原因', 'request' => $row, 'compensation' => null];
        $compensation = null; $shouldRefund = $action === 'resolve' && ($refund || $row->request_type === KcAfterSales::TYPE_REFUND);
        if ($shouldRefund) {
            $order = Order::where('trade_no', (string) $row->trade_no)->first();
            if (!$order) return ['ok' => false, 'error' => '原订单不存在，暂不能退款', 'request' => $row, 'compensation' => null];
            $result = (new CompensationService())->handleTerminalFailure($order, 'after_sales_refund', '售后退款申请');
            if (!$result['ok']) return ['ok' => false, 'error' => $result['error'], 'request' => $row, 'compensation' => $result['compensation'] ?? null];
            $compensation = $result['compensation'];
        }
        try {
            $updated = DB::transaction(function () use ($row, $nextStatus, $operatorRef, $note, $action) {
                $locked = KcAfterSales::whereKey($row->id)->lockForUpdate()->first(); if (!$locked) throw new \RuntimeException('售后申请不存在');
                if ($locked->isFinal() && $locked->status !== $nextStatus) throw new \RuntimeException('售后申请已被其他管理员处理');
                $locked->status = $nextStatus; $locked->operator_ref = $this->cleanText($operatorRef, 191);
                if ($note !== '') { $locked->admin_note = $note; $locked->resolution = $note; } elseif ($action === 'resolve' && $locked->resolution === '') $locked->resolution = '售后申请已处理';
                if (in_array($nextStatus, [KcAfterSales::STATUS_REJECTED, KcAfterSales::STATUS_RESOLVED], true)) $locked->processed_at = now();
                $locked->save(); if ($note !== '') $this->addMessageRow($locked, 'admin', $locked->operator_ref, $note); return $locked;
            });
            return ['ok' => true, 'error' => '', 'request' => $updated, 'compensation' => $compensation];
        } catch (\Throwable $e) { return ['ok' => false, 'error' => $e->getMessage(), 'request' => $this->find($requestNo), 'compensation' => $compensation]; }
    }

    public function listForUser(int $userId, int $limit = 50): array { return KcAfterSales::where('user_id', $userId)->orderByDesc('created_at')->limit(max(1, min(100, $limit)))->get()->map(fn (KcAfterSales $row) => $row->toPublicPayload())->all(); }
    public function find(string $requestNo): ?KcAfterSales { return KcAfterSales::where('request_no', trim($requestNo))->first(); }
    public function findByUser(string $requestNo, int $userId): ?KcAfterSales { return KcAfterSales::where('request_no', trim($requestNo))->where('user_id', $userId)->first(); }
    public function publicDetail(?KcAfterSales $row): ?array { return $row ? $row->toPublicPayload($this->messages($row, false)) : null; }
    public function listForAdmin(?string $status = null, ?string $type = null, int $limit = 100): array { $q = KcAfterSales::query()->orderByDesc('created_at')->limit(max(1, min(200, $limit))); if ($status) $q->where('status', substr($status, 0, 24)); if ($type) $q->where('request_type', substr($type, 0, 24)); return $q->get()->map(fn (KcAfterSales $row) => $this->adminPayload($row))->all(); }
    public function adminDetail(?KcAfterSales $row): ?array { return $row ? $this->adminPayload($row, true) : null; }
    protected function adminPayload(KcAfterSales $row, bool $withMessages = false): array { return array_merge($row->toPublicPayload($withMessages ? $this->messages($row, true) : []), ['order_id' => (int) $row->order_id, 'user_id' => (int) $row->user_id, 'admin_note' => (string) $row->admin_note, 'operator_ref' => (string) $row->operator_ref]); }
    protected function messages(KcAfterSales $row, bool $admin): array { return DB::table('v2_plugin_kc_after_sales_messages')->where('after_sales_id', (int) $row->id)->orderBy('created_at')->get()->map(fn ($m) => ['sender' => $admin ? (string) $m->sender_type : (in_array((string) $m->sender_type, ['admin', 'system'], true) ? (string) $m->sender_type : 'user'), 'content' => $this->cleanText((string) $m->content, 1000), 'created_at' => $m->created_at ? strtotime((string) $m->created_at) : null])->all(); }
    protected function addMessageRow(KcAfterSales $row, string $senderType, string $senderRef, string $content): void { DB::table('v2_plugin_kc_after_sales_messages')->insert(['after_sales_id' => (int) $row->id, 'sender_type' => substr($senderType, 0, 16), 'sender_ref' => $this->cleanText($senderRef, 191), 'content' => $this->cleanText($content, 1000), 'created_at' => now()]); }
    protected function newRequestNo(): string { return 'AS-' . date('ymdHis') . '-' . strtoupper(bin2hex(random_bytes(3))); }
    protected function cleanText(string $text, int $limit): string { $text = trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $text) ?? ''); return mb_substr($text, 0, $limit); }
}
