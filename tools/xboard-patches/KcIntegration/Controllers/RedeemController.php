<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use App\Models\Order;
use Plugin\KcIntegration\Models\KcCard;
use Plugin\KcIntegration\Services\CompensationService;
use Plugin\KcIntegration\Services\RiskService;
use Plugin\KcIntegration\Support\KcGateway;

/**
 * 前台兑卡控制器（FEAT-004 · D1）
 *
 * 为什么需要这一层：
 *   1. **CORS**：KC（server.js）没有任何 CORS 配置，浏览器从商城域名直连 KC 会被同源策略拦掉。
 *      服务端调用不受同源限制，所以必须由 Xboard 代理。
 *   2. **不需要登录**：CDK 本身就是凭证 —— 兑出来的订阅打在**用户自己粘贴的 ChatGPT 账号**上，
 *      因此「谁去兑」不改变「商品归谁」。这是本组接口刻意**不挂 'user' 中间件**的原因。
 *
 * ⚠️ 安全要点（公开接口的必要防护，改动前务必理解）：
 *   - **限流**：路由挂了 throttle，防刷。
 *   - **Origin 校验**：只接受来自本站的浏览器请求（见 ensureSameOrigin）。
 *   - **不落 body**：session 字段含用户 ChatGPT 凭据，**绝不写日志**。
 *   - **脱敏**：上游 message 已在 KC 侧脱敏，本层再做一次长度截断防御。
 */
class RedeemController extends PluginController
{
    /** 查 KC 的超时（秒）—— 用户在前台等，必须短 */
    private const TIMEOUT = 8;
    private const CONNECT_TIMEOUT = 3;

    /**
     * 验证 CDK 是否可用。
     * POST /kc/redeem/verify
     */
    public function verify(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }
        if ($error = $this->ensureSameOrigin($request)) {
            return $this->fail($error);
        }

        $request->validate([
            'cdk' => 'required|string|max:64',
        ]);

        $cdk = trim((string) $request->input('cdk'));

        $risk = (new RiskService())->guardRedeem($request, $cdk, null, false);
        if (!$risk['allowed']) {
            return $this->fail($this->riskFailure($risk));
        }

        $gateway = new KcGateway($this->getConfig('kc_base_url', ''), self::TIMEOUT, self::CONNECT_TIMEOUT);
        $res = $gateway->post('/api/verify-cdk', ['cdk' => $cdk]);

        if (!$res['ok']) {
            (new RiskService())->recordRedeemFailure($request, $cdk);
            $failure = $res['data'] ?? [];
            $cdkState = $this->canonicalCdkState(
                (string) ($failure['state'] ?? $failure['status'] ?? ''),
                (string) ($failure['status_cn'] ?? '')
            );
            return $this->fail([400, $res['error']], [
                'cdk'         => $cdk,
                'state'       => $cdkState,
                'cdk_state'   => $cdkState,
                'status_cn'   => (string) ($failure['status_cn'] ?? ''),
                'terminal'    => $this->cdkStateIsTerminal($cdkState),
                'next_action' => (string) ($failure['next_action'] ?? $this->cdkNextAction($cdkState)),
                'message'     => $this->sanitize((string) ($res['error'] ?? '卡密验证失败')),
            ]);
        }

        $data = $res['data'] ?? [];

        // KC 契约（实测 server.js:3833）：成功 → {success:true, data:{type, plan_type, plan_label}}
        // 若该 CDK 正在开通中，会额外带 status=processing + jobKey，前台据此直接进"开通中"态。
        return $this->success([
            'cdk'        => $cdk,
            'type'       => (string) ($data['type'] ?? '自助'),
            'plan_type'  => (string) ($data['plan_type'] ?? 'plus'),
            'plan_label' => (string) ($data['plan_label'] ?? ''),
            'status'     => (string) ($data['status'] ?? 'pending'),
            'state'      => $this->canonicalCdkState((string) ($data['state'] ?? $data['status'] ?? ''), (string) ($data['status_cn'] ?? '')),
            'cdk_state'  => $this->canonicalCdkState((string) ($data['state'] ?? $data['status'] ?? ''), (string) ($data['status_cn'] ?? '')),
            'status_cn'  => (string) ($data['status_cn'] ?? ''),
            'terminal'   => (bool) ($data['terminal'] ?? false),
            'next_action' => (string) ($data['next_action'] ?? $this->cdkNextAction((string) ($data['state'] ?? ''))),
            'job_key'    => (string) ($data['jobKey'] ?? ''),
            'message'    => $this->sanitize((string) ($data['message'] ?? '')),
        ]);
    }

    /**
     * 提交 Session 启动自动开通。
     * POST /kc/redeem/start
     */
    public function start(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }
        if ($error = $this->ensureSameOrigin($request)) {
            return $this->fail($error);
        }

        $request->validate([
            'cdk'     => 'required|string|max:64',
            'session' => 'required|string|min:20|max:20000',
        ]);

        $cdk     = trim((string) $request->input('cdk'));
        $session = (string) $request->input('session');

        $gateway = new KcGateway($this->getConfig('kc_base_url', ''), self::TIMEOUT, self::CONNECT_TIMEOUT);

        // 先查询一次运行态：用户重复点击、网络重试或页面恢复时，直接复用已有任务，
        // 避免再次提交同一张卡。最终裁决仍在 KC /api/run-process 的数据库原子锁中，
        // 这里仅用于减少重复请求和改善响应速度。
        $state = $gateway->get('/api/cdk/query', ['cdk' => $cdk]);
        $stateData = $state['data'] ?? [];
        if ($state['ok'] && ($stateData['status'] ?? '') === '开通中' && !empty($stateData['jobKey'])) {
            return $this->success([
                'cdk'        => $cdk,
                'job_key'    => (string) $stateData['jobKey'],
                'idempotent' => true,
                'message'    => '该卡已在开通处理中，将继续显示原任务进度',
            ]);
        }

        $risk = (new RiskService())->guardRedeem($request, $cdk, $session, true);
        if (!$risk['allowed']) {
            return $this->fail($this->riskFailure($risk));
        }

        // ⚠️ session 必须是**字符串**：KC 侧 handleActivationRequest 会做
        //    String(req.body?.session || req.body?.token || '').trim()，
        //    传对象会变成 "[object Object]" 并被判为「该 Token 不合法：格式错误」。
        $res = $gateway->post('/api/run-process', [
            'cdk'     => $cdk,
            'session' => $session,
        ]);

        if (!$res['ok']) {
            (new RiskService())->recordRedeemFailure($request, $cdk, $session);
            return $this->fail([400, $res['error']]);
        }

        $data = $res['data'] ?? [];

        // 注意：KC 建单返回 HTTP 202 也算成功，真正结果要靠轮询 /kc/redeem/status
        return $this->success([
            'cdk'     => $cdk,
            'job_key' => (string) ($data['jobKey'] ?? ''),
            'message' => $this->sanitize((string) ($data['message'] ?? '任务已启动，正在为您开通中...')),
        ]);
    }

    /**
     * 查询开通进度（前台轮询）。
     * GET /kc/redeem/status?cdk=xxx
     *
     * 优先走 KC 精确接口（带集成密钥，含真实 progress + 失败原因）；
     * 集成密钥没配或接口不可用时，静默回落公开的 /api/cdk/query（只有三态）。
     */
    public function status(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $request->validate([
            'cdk' => 'required|string|max:64',
        ]);

        $cdk = trim((string) $request->input('cdk'));

        $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
        $apiKey  = (string) $this->getConfig('integration_key', '');

        if ($baseUrl === '') {
            return $this->fail([400, 'KC 地址未配置']);
        }

        // —— 首选：C5 精确接口（真实进度 + 失败原因）
        if ($apiKey !== '') {
            try {
                $resp = Http::withHeaders([
                    'X-Integration-Key' => $apiKey,
                    'Accept'            => 'application/json',
                ])
                    ->timeout(self::TIMEOUT)
                    ->connectTimeout(self::CONNECT_TIMEOUT)
                    ->get($baseUrl . '/api/integration/task/status', ['cdk' => $cdk]);

                if ($resp->successful()) {
                    $json = $resp->json();
                    if (is_array($json) && ($json['success'] ?? false) === true) {
                        $d = $json['data'] ?? [];
                        $progress = $d['progress'] ?? null;
                        $taskStatus = strtolower((string) ($d['taskStatus'] ?? ''));
                        $statusCn = (string) ($d['status'] ?? '');
                        $cdkState = $this->canonicalCdkState((string) ($d['state'] ?? $d['cdk_state'] ?? ''), $statusCn);
                        $state = $this->canonicalTaskState($taskStatus, $statusCn, $cdkState);
                        $compensation = null;
                        if (in_array($taskStatus, ['failed', 'fail', 'error'], true)) {
                            $compensation = $this->syncFailedCompensation($cdk);
                        }

                        return $this->success([
                            'cdk'        => $cdk,
                            'task_status' => (string) ($d['taskStatus'] ?? ''),
                            'status_cn'  => $statusCn,
                            'state'      => $state,
                            'cdk_state'  => $cdkState,
                            'terminal'   => (bool) ($d['terminal'] ?? in_array($state, ['completed', 'failed', 'compensating', 'manual'], true)),
                            'next_action' => (string) ($d['next_action'] ?? $this->cdkNextAction($cdkState)),
                            'updated_at' => time(),
                            'progress'   => is_numeric($progress) ? max(0, min(100, (int) $progress)) : null,
                            'message'    => $this->sanitize((string) ($d['message'] ?? '')),
                            'has_task'   => (bool) ($d['hasTask'] ?? false),
                            'source'     => 'task',
                            'compensation' => $compensation,
                        ]);
                    }
                }
                if ($resp->status() === 404) {
                    return $this->success([
                        'cdk' => $cdk, 'task_status' => '', 'status_cn' => '未找到',
                        'state' => 'failed', 'cdk_state' => 'not_found', 'terminal' => true,
                        'next_action' => 'contact_support', 'updated_at' => time(),
                        'progress' => 0, 'message' => '未找到该卡密', 'has_task' => false, 'source' => 'task-not-found',
                    ]);
                }
            } catch (\Throwable $e) {
                // 静默回落，不打扰用户
            }

            return $this->success([
                'cdk' => $cdk, 'task_status' => '', 'status_cn' => '',
                'state' => 'running', 'terminal' => false, 'updated_at' => time(),
                'progress' => null, 'message' => '', 'has_task' => false, 'source' => 'task-miss',
            ]);
        }

        // —— 回落：公开聚合接口（中文三态，「能不能用」而不是「跑到哪了」）
        try {
            $resp = Http::withHeaders(['Accept' => 'application/json'])
                ->timeout(self::TIMEOUT)
                ->connectTimeout(self::CONNECT_TIMEOUT)
                ->get($baseUrl . '/api/cdk/query', ['cdk' => $cdk]);

            if ($resp->failed()) {
                if ($resp->status() === 404) {
                    return $this->success([
                        'cdk' => $cdk, 'task_status' => '', 'status_cn' => '未找到',
                        'state' => 'failed', 'cdk_state' => 'not_found', 'terminal' => true,
                        'next_action' => 'contact_support', 'updated_at' => time(),
                        'progress' => 0, 'message' => '未找到该卡密', 'has_task' => false, 'source' => 'fallback-not-found',
                    ]);
                }
                return $this->success([
                    'cdk' => $cdk, 'task_status' => '', 'status_cn' => '',
                    'state' => 'running', 'terminal' => false, 'updated_at' => time(),
                    'progress' => null, 'message' => '状态暂不可实时更新', 'has_task' => false, 'source' => 'fallback-miss',
                ]);
            }

            $json = $resp->json();
            $statusCn = (string) ($json['data']['status'] ?? '');
            $cdkState = $this->canonicalCdkState((string) ($json['data']['state'] ?? ''), $statusCn);
            $state = $this->canonicalTaskState('', $statusCn, $cdkState);

            return $this->success([
                'cdk'         => $cdk,
                'task_status' => '',
                'status_cn'   => $statusCn,
                'state'       => $state,
                'cdk_state'   => $cdkState,
                'terminal'    => $this->cdkStateIsTerminal($cdkState) || in_array($state, ['completed', 'failed', 'compensating', 'manual'], true),
                'next_action' => $this->cdkNextAction($cdkState),
                'updated_at'  => time(),
                'progress'    => null,
                'message'     => '',
                'has_task'    => false,
                'source'      => 'fallback',
            ]);
        } catch (\Throwable $e) {
            return $this->success([
                'cdk' => $cdk, 'task_status' => '', 'status_cn' => '',
                'state' => 'running', 'terminal' => false, 'updated_at' => time(),
                'progress' => null, 'message' => '', 'has_task' => false, 'source' => 'fallback-error',
            ]);
        }
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    protected function canonicalCdkState(string $state = '', string $statusCn = ''): string
    {
        $state = strtolower(trim($state));
        if (in_array($state, ['not_found', 'available', 'cooldown', 'processing', 'completed', 'used', 'frozen', 'expired', 'failed', 'manual'], true)) {
            return $state;
        }
        return match (trim($statusCn)) {
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
    }

    protected function cdkStateIsTerminal(string $state): bool
    {
        return in_array($state, ['not_found', 'completed', 'used', 'frozen', 'expired', 'failed', 'manual'], true);
    }

    protected function cdkNextAction(string $state): string
    {
        return match ($state) {
            'available' => 'provide_credentials',
            'processing', 'cooldown' => 'wait',
            'completed', 'used' => 'view_order',
            'not_found', 'frozen', 'expired', 'failed', 'manual' => 'contact_support',
            default => 'wait',
        };
    }

    protected function canonicalTaskState(string $taskStatus, string $statusCn = '', string $cdkState = ''): string
    {
        $taskStatus = strtolower(trim($taskStatus));
        if (in_array($cdkState, ['expired', 'frozen', 'manual', 'not_found'], true)) {
            return $cdkState === 'expired' ? 'failed' : 'manual';
        }
        if (in_array($cdkState, ['completed', 'used'], true)) return 'completed';
        if ($cdkState === 'available') return 'pending';
        if ($cdkState === 'cooldown') return 'pending';
        if (in_array($taskStatus, ['success', 'done', 'completed'], true) || $statusCn === '已使用') return 'completed';
        if (in_array($taskStatus, ['failed', 'fail', 'error'], true)) return 'failed';
        if ($statusCn === '未使用') return 'pending';
        return 'running';
    }

    /**
     * 公开轮询拿到明确 failed 时同步卡片和补偿台账。
     * KC 不可达、排队和未知状态都不走这里，避免过早退余额。
     */
    protected function syncFailedCompensation(string $cdk): ?array
    {
        try {
            $card = KcCard::where('cdk_code', $cdk)->first();
            $order = $card ? Order::where('trade_no', $card->trade_no)->first() : null;
            if (!$card || !$order) {
                return null;
            }

            $card->kc_status = KcCard::KC_FAILED;
            $card->kc_message = '代充任务失败';
            $card->kc_synced_at = now();
            $card->save();

            $result = (new CompensationService())->handleTerminalFailure(
                $order,
                'kc_task_failed',
                'KC 代充任务失败'
            );
            return $result['compensation']?->toPublicPayload();
        } catch (\Throwable $e) {
            Log::warning('[KcIntegration] 兑卡轮询同步失败补偿异常', [
                'cdk_suffix' => substr($cdk, -6),
                'error' => $e->getMessage(),
            ]);
            return null;
        }
    }

    /**
     * 只接受来自本站的浏览器请求。
     *
     * 公开接口若不校验 Origin，任何人都能在自己页面上引用本接口刷 CDK。
     * 同源请求（curl / 服务端调用）没有 Origin 头 —— 这类放行，因为真正的
     * 浏览器跨站请求**一定**会带 Origin。
     *
     * @return array|null [状态码, 消息] 或 null 表示通过
     */
    protected function ensureSameOrigin(Request $request): ?array
    {
        $origin = (string) $request->headers->get('Origin', '');
        if ($origin === '') {
            return null; // 非浏览器请求（同源 fetch 也可能不带），放行
        }

        $host = $request->getSchemeAndHttpHost();
        if (!hash_equals($host, rtrim($origin, '/'))) {
            // 额外放宽：app_url 配置的域名也算本站（前台可能配了正式域名）
            $appUrl = rtrim((string) admin_setting('app_url', ''), '/');
            if ($appUrl === '' || !hash_equals($appUrl, rtrim($origin, '/'))) {
                Log::channel('daily')->warning('[KcIntegration] 兑卡接口拒绝跨站请求', [
                    'origin' => $origin, 'host' => $host,
                ]);
                return [403, '请求来源不合法'];
            }
        }

        return null;
    }

    /**
     * 上游文案脱敏 + 截断。
     *
     * KC 侧已按关键词过滤过，这里只做长度与二次兜底（纵深防御）。
     */
    protected function sanitize(string $message): string
    {
        if ($message === '') {
            return '';
        }

        // 兜底：万一上游漏了，这里再拦一次敏感词
        $sensitive = ['access_token', 'refresh_token', 'accessToken', 'password', 'passwd', 'bearer', 'sk-'];
        $lower = mb_strtolower($message);
        foreach ($sensitive as $kw) {
            if (mb_strpos($lower, mb_strtolower($kw)) !== false) {
                return '开通遇到问题，详情请联系客服';
            }
        }

        // 纵深防御：即使上游没有带字段名，也不要把 JWT、Bearer 或 Session Cookie 回传到前台。
        if (preg_match('/\bBearer\s+[^\s,}\"]+|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|__Secure-next-auth\.session-token(?:\.\d+)?=[^;\s]+/i', $message)) {
            return '开通遇到问题，详情请联系客服';
        }

        return mb_substr($message, 0, 120);
    }

    /** 风控拒绝使用统一、无供应商细节的前台文案。 */
    protected function riskFailure(array $risk): array
    {
        $action = (string) ($risk['action'] ?? 'block');
        if ($action === 'manual') return [403, '当前请求需要人工核验，请联系客服'];
        if ($action === 'challenge') return [429, '请求需要进一步验证，请稍后重试或联系客服'];
        $retry = max(0, (int) ($risk['retry_after'] ?? 0));
        return [429, $retry > 0 ? '操作过于频繁，请稍后再试' : '当前请求暂时无法处理，请稍后再试'];
    }
}
