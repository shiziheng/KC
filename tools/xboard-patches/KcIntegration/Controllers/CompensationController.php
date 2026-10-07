<?php

namespace Plugin\KcIntegration\Controllers;

use App\Models\Order;
use App\Http\Controllers\PluginController;
use Illuminate\Http\Request;
use Plugin\KcIntegration\Models\KcCard;
use Plugin\KcIntegration\Services\CompensationService;
use Plugin\KcIntegration\Support\KcGateway;

/**
 * 代充失败补偿接口。
 *
 * 用户侧只看到脱敏后的补偿状态；管理员侧可以重新检查 KC、重试失败补偿，
 * 或在实际外部退款完成后留下操作人和备注。
 */
class CompensationController extends PluginController
{
    private const TIMEOUT = 5;
    private const CONNECT_TIMEOUT = 2;

    public function mine(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $rows = (new CompensationService())->listForUser((int) $request->user()->id);
        return $this->success(['compensations' => $rows]);
    }

    public function adminList(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $status = trim((string) $request->input('status', ''));
        return $this->success([
            'compensations' => (new CompensationService())->listForAdmin($status !== '' ? $status : null),
        ]);
    }

    public function retry(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $request->validate(['trade_no' => 'required|string|max:36']);
        $tradeNo = trim((string) $request->input('trade_no'));
        $order = Order::where('trade_no', $tradeNo)->first();
        if (!$order) {
            return $this->fail([404, '原订单不存在']);
        }

        $result = (new CompensationService())->handleTerminalFailure(
            $order,
            'manual_retry',
            '管理员重试失败补偿'
        );
        if (!$result['ok']) {
            return $this->fail([500, $result['error']]);
        }

        return $this->success([
            'idempotent' => (bool) $result['skipped'],
            'compensation' => $result['compensation']?->toPublicPayload(),
        ]);
    }

    public function recheck(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $request->validate(['trade_no' => 'required|string|max:36']);
        $tradeNo = trim((string) $request->input('trade_no'));
        $order = Order::where('trade_no', $tradeNo)->first();
        $card = $order ? KcCard::where('trade_no', $tradeNo)->first() : null;
        if (!$order || !$card || !$card->cdk_code) {
            return $this->fail([404, '订单或 KC 任务不存在']);
        }

        $baseUrl = (string) $this->getConfig('kc_base_url', '');
        $apiKey = (string) $this->getConfig('integration_key', '');
        if ($baseUrl === '' || $apiKey === '') {
            return $this->fail([400, 'KC 地址或集成密钥未配置']);
        }

        $gateway = new KcGateway($baseUrl, self::TIMEOUT, self::CONNECT_TIMEOUT);
        $result = $gateway->get(
            '/api/integration/task/status',
            ['cdk' => (string) $card->cdk_code],
            ['X-Integration-Key' => $apiKey]
        );
        if (!$result['ok']) {
            return $this->fail([502, 'KC 状态暂时无法确认，请稍后重试']);
        }

        $data = $result['data'] ?? [];
        $taskStatus = strtolower((string) ($data['taskStatus'] ?? ''));
        if (in_array($taskStatus, ['failed', 'fail', 'error'], true)) {
            $card->kc_status = KcCard::KC_FAILED;
            $card->kc_progress = is_numeric($data['progress'] ?? null)
                ? max(0, min(100, (int) $data['progress']))
                : $card->kc_progress;
            $card->kc_message = '代充任务失败';
            $card->kc_synced_at = now();
            $card->save();

            $compensation = (new CompensationService())->handleTerminalFailure(
                $order,
                'kc_task_failed',
                'KC 代充任务失败'
            );
            if (!$compensation['ok']) {
                return $this->fail([500, $compensation['error']]);
            }

            return $this->success([
                'task_status' => 'failed',
                'compensation' => $compensation['compensation']?->toPublicPayload(),
                'idempotent' => (bool) $compensation['skipped'],
            ]);
        }

        if (in_array($taskStatus, ['success', 'done', 'completed'], true)) {
            $card->kc_status = KcCard::KC_COMPLETED;
            $card->kc_progress = 100;
            $card->kc_synced_at = now();
            $card->save();
        }

        return $this->success([
            'task_status' => $taskStatus !== '' ? $taskStatus : 'unknown',
            'compensation' => (new CompensationService())->find($tradeNo)?->toPublicPayload(),
            'message' => 'KC 尚未确认失败，不自动退款',
        ]);
    }

    public function markManualDone(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $request->validate([
            'trade_no' => 'required|string|max:36',
            'note' => 'nullable|string|max:500',
        ]);

        $admin = $request->user();
        $operator = (string) ($admin?->email ?: ('admin:' . (int) ($admin?->id ?? 0)));
        $result = (new CompensationService())->markManualDone(
            trim((string) $request->input('trade_no')),
            $operator,
            trim((string) $request->input('note', ''))
        );
        if (!$result['ok']) {
            return $this->fail([400, $result['error']]);
        }

        return $this->success([
            'compensation' => $result['compensation']?->toPublicPayload(),
        ]);
    }
}
