<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use App\Models\Order;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Plugin\KcIntegration\Models\KcCard;
use Plugin\KcIntegration\Services\CompensationService;

/**
 * KC 开通状态查询控制器（段C4 / 段C5）
 *
 * 为什么需要这一层代理：
 *   KC（server.js）**没有任何 CORS 配置**，浏览器同源策略会拦掉前台到 KC 的直连请求。
 *   服务端调用不受同源限制，因此由 Xboard 后端代为查询，前台只调自家接口。
 *
 * 附带好处：KC 的查询接口不必暴露给任意站点，且可复用插件已有的 kc_base_url 配置。
 *
 * 段C5 增强（精确状态）：
 *   先调 KC 的 /api/integration/task/status（带集成密钥）取**真实 progress + message**，
 *   失败则静默回落段C4 的 /api/cdk/query。C5 是「增强层」而非「替代层」——
 *   新接口挂掉时原有能力不受影响。
 */
class StatusController extends PluginController
{
    /** 单次请求 KC 的超时（秒）—— 前台要等，不宜过长 */
    private const TIMEOUT = 3;
    private const CONNECT_TIMEOUT = 2;

    /**
     * 查询单个订单的 KC 开通状态。
     * GET /user/kc/status?trade_no=xxx
     */
    public function status(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $request->validate([
            'trade_no' => 'required|string|max:36',
        ]);

        $tradeNo = (string) $request->input('trade_no');
        $userId  = (int) $request->user()->id;

        // 越权防护：订单必须属于当前用户
        $order = Order::where('trade_no', $tradeNo)->where('user_id', $userId)->first();
        if (!$order) {
            return $this->fail([400, '订单不存在或无权访问']);
        }

        $card = KcCard::where('trade_no', $tradeNo)->first();
        if (!$card) {
            return $this->success([
                'state'        => KcCard::STATE_PENDING,
                'task_status'  => KcCard::STATE_PENDING,
                'kc_status'    => KcCard::KC_PENDING,
                'status_cn'    => KcCard::stateLabel(KcCard::STATE_PENDING),
                'terminal'     => false,
                'synced'       => false,
                'stale'        => false,
                'progress'     => 0,
                'message'      => '等待系统发放卡密',
                'updated_at'   => null,
            ]);
        }

        if (!$card->isIssued()) {
            // 卡密还没发放（发放失败 / 跳过），谈不上开通
            return $this->success($this->payload($card, false, false));
        }

        // 已是终态：直接返回缓存，不再打 KC（省一次往返）
        // 段C6：progress / message 已在同步时持久化到本表，这里直接取用 ——
        //        否则失败原因会随「终态短路」一起丢失（段C5 的设计盲区）。
        if ($card->isKcTerminal()) {
            if ($card->kc_status === KcCard::KC_FAILED) {
                $this->compensateFailedOrder($order);
            }
            return $this->success($this->payload($card, true, false, '', [
                'progress' => $card->kc_progress,
                'message'  => $card->kc_message,
            ]));
        }

        // 段C5：先试精确接口（真实 progress + message），失败静默回落 C4 的聚合接口
        $detail = $this->fetchKcTaskDetail((string) $card->cdk_code);
        if ($detail['ok']) {
            // 精确接口可用：status / taskStatus 都以任务记录为准
            $mapped = $detail['kc_status'];
            if ($mapped !== $card->kc_status) {
                $card->kc_status = $mapped;
            }
            // 段C6：一并持久化，保证终态短路与页面刷新后仍可见
            $card->kc_progress  = $detail['progress'];
            // 只持久化通用状态文案，不把供应商原始错误/凭据片段写入卡密记录。
            // 用现有 kc_message 保存脱敏的 CDK 状态标签，避免增加一张状态表；
            // payload() 会在后续终态短路时恢复 cdk_state。
            $card->kc_message   = (string) ($detail['cdk_status_cn'] ?: KcCard::stateLabel($card->canonicalState()));
            $card->kc_synced_at = now();
            $this->persistQuietly($card, $tradeNo);

            if ($mapped === KcCard::KC_FAILED) {
                $this->compensateFailedOrder($order);
            }

            return $this->success($this->payload($card, true, false, '', [
                'progress' => $detail['progress'],
                'message'  => $detail['message'],
                'cdk_state' => $detail['cdk_state'],
                'cdk_status_cn' => $detail['cdk_status_cn'],
                'next_action' => $detail['next_action'],
            ]));
        }

        Log::info('[KcIntegration] C5 精确接口不可用，回落 C4 聚合接口', [
            'trade_no' => $tradeNo,
            'reason'   => $detail['error'],
        ]);

        // 实时代理查询（段C4 原有路径，保持不变）
        $result = $this->fetchKcStatus((string) $card->cdk_code);

        if ($result['ok'] === false) {
            // 降级：KC 不可达时返回本地缓存状态，不报错
            return $this->success($this->payload($card, false, true, $result['error']));
        }

        if ($result['kc_status'] !== $card->kc_status) {
            $card->kc_status = $result['kc_status'];
        }
        $card->kc_synced_at = now();
        $this->persistQuietly($card, $tradeNo);

        return $this->success($this->payload($card, true, false));
    }
    /**
     * 静默回写卡片（回写失败不影响本次响应）。
     */
    protected function persistQuietly(KcCard $card, string $tradeNo): void
    {
        try {
            $card->save();
        } catch (\Throwable $e) {
            Log::warning('[KcIntegration] 回写 kc_status 失败', [
                'trade_no' => $tradeNo,
                'error'    => $e->getMessage(),
            ]);
        }
    }

    /**
     * 失败状态才允许触发补偿；KC 不可达/排队状态不会自动退款。
     * 补偿失败只记录日志，不阻断用户查看最后状态。
     */
    protected function compensateFailedOrder(Order $order): void
    {
        try {
            (new CompensationService())->handleTerminalFailure(
                $order,
                'kc_task_failed',
                'KC 代充任务失败'
            );
        } catch (\Throwable $e) {
            Log::warning('[KcIntegration] 创建失败补偿记录异常', [
                'trade_no' => (string) $order->trade_no,
                'error' => $e->getMessage(),
            ]);
        }
    }

    /**
     * 组装响应体。
     *
     * @param array $extra 段C5 附加字段：progress / message
     */
    protected function payload(KcCard $card, bool $synced, bool $stale, string $error = '', array $extra = []): array
    {
        $kcStatus = $card->kc_status ?: KcCard::KC_PENDING;

        $compensation = (new CompensationService())->find((string) $card->trade_no);
        $state = $card->canonicalState($compensation?->status);
        $cachedCdkState = match ((string) $card->kc_message) {
            '未找到' => 'not_found',
            '未使用' => 'available',
            '冷却中' => 'cooldown',
            '开通中' => 'processing',
            '已完成' => 'completed',
            '已使用' => 'used',
            '已冻结' => 'frozen',
            '已过期' => 'expired',
            '开通失败' => 'failed',
            '待人工处理' => 'manual',
            default => '',
        };
        $data = [
            'state'      => $state,
            'task_status' => $state,
            'kc_status' => $kcStatus,
            'status_cn' => KcCard::stateLabel($state),
            'terminal'  => KcCard::stateIsTerminal($state),
            'synced'    => $synced,
            'stale'     => $stale,
            'issued'    => $card->isIssued(),
            'updated_at' => ($card->kc_synced_at ?: $card->updated_at)?->timestamp,
        ];

        if ($cachedCdkState !== '') {
            $data['cdk_state'] = $cachedCdkState;
            $data['cdk_status_cn'] = (string) $card->kc_message;
            $data['next_action'] = in_array($cachedCdkState, ['completed', 'used'], true)
                ? 'view_order'
                : (in_array($cachedCdkState, ['expired', 'frozen', 'failed', 'manual', 'not_found'], true) ? 'contact_support' : 'wait');
        }

        if (!empty($extra['cdk_state'])) {
            $data['cdk_state'] = (string) $extra['cdk_state'];
            $data['cdk_status_cn'] = (string) ($extra['cdk_status_cn'] ?? '');
            $data['next_action'] = (string) ($extra['next_action'] ?? 'wait');
        }

        // 段C5：真实进度与提示文案（拿不到时为 null，前台自行退回默认值）
        // 段C6：$extra 未给（如终态短路 / C4 降级路径）时，回落到本表持久化值，
        //        保证页面刷新、KC 暂时不可达时也能展示最后一次已知的真实进度与原因。
        if (array_key_exists('progress', $extra)) {
            $data['progress'] = is_numeric($extra['progress'])
                ? max(0, min(100, (int) $extra['progress']))
                : null;
        } elseif ($card->kc_progress !== null) {
            $data['progress'] = max(0, min(100, (int) $card->kc_progress));
        }

        $data['message'] = match ($state) {
            KcCard::STATE_PENDING => '等待系统发放卡密',
            KcCard::STATE_VALIDATING => '正在校验代充任务',
            KcCard::STATE_RUNNING => '开通处理中…',
            KcCard::STATE_COMPLETED => '开通完成',
            KcCard::STATE_FAILED => '开通未成功，请联系客服',
            KcCard::STATE_COMPENSATING => '代充未完成，正在处理补偿',
            KcCard::STATE_MANUAL => '结果待确认，请联系客服处理',
            default => '处理中',
        };

        if (array_key_exists('message', $extra) && is_string($extra['message']) && $extra['message'] !== '') {
            $data['message'] = $extra['message'];
        }

        if ($stale) {
            // 明确告知前台"这是缓存值、本次没拿到实时结果"，便于 UI 提示
            $data['stale']  = true;
            $data['reason'] = '暂时无法获取实时状态';
        }

        if ($compensation) {
            $data['compensation'] = $compensation->toPublicPayload();
        }

        return $data;
    }

    /**
     * 段C5：调 KC 精确任务状态接口，取真实 progress / message。
     *
     * ⚠️ 与 /api/cdk/query 的语义差异（关键）：
     *   KC 代充**失败时会回滚卡密状态**，所以聚合接口会显示「未使用」，
     *   失败态在这一层才能拿到（taskStatus='failed' → kc_status='failed'）。
     *
     * 该接口**必须带集成密钥**（走 X-Integration-Key），与公开的
     * /api/cdk/query 不同，因此不会把内部 message 泄露给任意站点。
     *
     * @return array{ok: bool, kc_status: string, progress: ?int, message: ?string, error: string}
     */
    protected function fetchKcTaskDetail(string $cdk): array
    {
        $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
        $apiKey  = (string) $this->getConfig('integration_key', '');

        if ($baseUrl === '' || $cdk === '' || $apiKey === '') {
            return ['ok' => false, 'kc_status' => '', 'progress' => null, 'message' => null,
                    'error' => 'KC 地址或集成密钥未配置'];
        }

        try {
            $response = Http::withHeaders([
                'X-Integration-Key' => $apiKey,
                'Accept'            => 'application/json',
            ])
                ->timeout(self::TIMEOUT)
                ->connectTimeout(self::CONNECT_TIMEOUT)
                ->get($baseUrl . '/api/integration/task/status', ['cdk' => $cdk]);
        } catch (\Throwable $e) {
            return ['ok' => false, 'kc_status' => '', 'progress' => null, 'message' => null,
                    'error' => '请求 KC 精确接口失败: ' . $e->getMessage()];
        }

        if ($response->failed()) {
            // 404（无该卡密）/ 401（密钥错）/ 403（集成未启用）都会落到这里 → 回落 C4
            return ['ok' => false, 'kc_status' => '', 'progress' => null, 'message' => null,
                    'error' => 'KC 精确接口 HTTP ' . $response->status()];
        }

        $json = $response->json();
        if (!is_array($json) || ($json['success'] ?? false) !== true) {
            return ['ok' => false, 'kc_status' => '', 'progress' => null, 'message' => null,
                    'error' => 'KC 精确接口内容异常'];
        }

        $data       = $json['data'] ?? [];
        $taskStatus = (string) ($data['taskStatus'] ?? '');

        // 任务态 → 内部四态。failed 只在精确接口里出现（聚合接口拿不到）
        $cdkState = strtolower(trim((string) ($data['cdk_state'] ?? $data['state'] ?? '')));
        $cdkStatusCn = (string) ($data['status_cn'] ?? '');
        if ($cdkState === 'expired' || $cdkState === 'frozen' || $cdkState === 'failed' || $cdkState === 'manual' || $cdkState === 'not_found') {
            $mapped = KcCard::KC_FAILED;
        } elseif (in_array($cdkState, ['completed', 'used'], true)) {
            $mapped = KcCard::KC_COMPLETED;
        } elseif (in_array($cdkState, ['processing'], true)) {
            $mapped = KcCard::KC_RUNNING;
        } elseif (in_array($cdkState, ['available', 'cooldown'], true)) {
            $mapped = KcCard::KC_PENDING;
        } elseif ($taskStatus === 'failed') {
            $mapped = KcCard::KC_FAILED;
        } else {
            $mapped   = KcCard::$kcStatusFromApi[$cdkStatusCn] ?? null;
        }

        if ($mapped === null) {
            return ['ok' => false, 'kc_status' => '', 'progress' => null, 'message' => null,
                    'error' => 'KC 精确接口返回未知状态: ' . mb_substr($taskStatus, 0, 40)];
        }

        $progress = $data['progress'] ?? null;
        $progress = is_numeric($progress) ? max(0, min(100, (int) $progress)) : null;
        $message  = isset($data['message']) && $data['message'] !== '' ? (string) $data['message'] : null;
        $nextAction = (string) ($data['next_action'] ?? '');
        if ($nextAction === '') {
            $nextAction = in_array($cdkState, ['completed', 'used'], true) ? 'view_order' : (in_array($cdkState, ['expired', 'frozen', 'failed', 'manual', 'not_found'], true) ? 'contact_support' : 'wait');
        }

        return [
            'ok'        => true,
            'kc_status' => $mapped,
            'progress'  => $progress,
            'message'   => $message,
            'cdk_state' => $cdkState !== '' ? $cdkState : null,
            'cdk_status_cn' => $cdkStatusCn,
            'next_action' => $nextAction,
            'error'     => '',
        ];
    }

    /**
     * 代理调用 KC 的 CDK 查询接口。
     *
     * ⚠️ KC 契约（实测 server.js:3893）：
     *    成功 → {"success":true,"data":{"status":"未使用|开通中|已使用", ...}}
     *    status 是**中文三态字符串**，不是枚举码。照直觉写 'running'/'used' 会永远对不上。
     *
     * @return array{ok: bool, kc_status: string, error: string}
     */
    protected function fetchKcStatus(string $cdk): array
    {
        $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
        if ($baseUrl === '' || $cdk === '') {
            return ['ok' => false, 'kc_status' => '', 'error' => 'KC 地址未配置或卡密为空'];
        }

        try {
            $response = Http::withHeaders(['Accept' => 'application/json'])
                ->timeout(self::TIMEOUT)
                ->connectTimeout(self::CONNECT_TIMEOUT)
                ->get($baseUrl . '/api/cdk/query', ['cdk' => $cdk]);
        } catch (\Throwable $e) {
            return ['ok' => false, 'kc_status' => '', 'error' => '请求 KC 失败: ' . $e->getMessage()];
        }

        if ($response->failed()) {
            return [
                'ok'         => false,
                'kc_status'  => '',
                'error'      => 'KC 返回 HTTP ' . $response->status(),
            ];
        }

        $json = $response->json();
        if (!is_array($json) || ($json['success'] ?? false) !== true) {
            return ['ok' => false, 'kc_status' => '', 'error' => 'KC 返回内容异常'];
        }

        $statusCn = (string) ($json['data']['status'] ?? '');
        $mapped   = KcCard::$kcStatusFromApi[$statusCn] ?? null;

        if ($mapped === null) {
            return ['ok' => false, 'kc_status' => '', 'error' => 'KC 返回未知状态: ' . mb_substr($statusCn, 0, 40)];
        }

        return ['ok' => true, 'kc_status' => $mapped, 'error' => ''];
    }
}
