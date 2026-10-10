<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use App\Models\Order;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

/**
 * 客服工作台（SP-2026-10-11 · P1）
 *
 * 只读聚合查询：给定「用户（邮箱/ID）」或「订单号」，一次返回客服所需的全部上下文：
 *   - 用户：余额、注册、最近登录、订阅状态
 *   - 订单：状态、金额、支付时间、卡密发放 / 开通状态
 *   - 充值：到账情况（待支付 / 已到账 / 异常）
 *   - 卡密：KC 侧状态、进度、脱敏提示（可实时向 KC 复核）
 *   - 售后 / 补偿：关联工单与补偿状态
 *
 * 安全边界（与产品红线一致）：
 *   - 严格只读：不提供任何改余额 / 改状态接口（补单走既有 /admin/kc/topups/credit 审核流程）
 *   - 不返回 Session / 密钥；KC 错误只回传系统通用文案
 *   - 仅 Xboard 管理端登录态（'user' + 'admin' 中间件）可访问
 *
 * 金额约定：所有「分」值由前端统一按 $（美元）展示（全站单币种：美元）。
 */
class SupportController extends PluginController
{
    private const ORDER_STATUS_CN = [
        0 => '待支付',
        1 => '处理中',
        2 => '已取消',
        3 => '已完成',
        4 => '已折抵',
    ];

    private const TOPUP_STATUS_CN = [
        'pending' => '待支付',
        'done' => '已到账',
        'failed' => '处理失败',
        'manual_review' => '人工复核',
        'overdue' => '已超时',
    ];

    public function page(Request $request)
    {
        $secure = trim((string) admin_setting('secure_path', admin_setting('frontend_admin_path', '')), '/');
        return response()->view('KcIntegration::support', ['securePath' => $secure]);
    }

    /**
     * 用户视角聚合：GET /admin/kc/support/user?q=<邮箱或用户ID>
     */
    public function user(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);

        $q = trim((string) $request->input('q', ''));
        if ($q === '') return $this->fail([422, '请输入用户邮箱或用户 ID']);
        if (mb_strlen($q) > 64) return $this->fail([422, '查询词过长']);

        $user = null;
        if (ctype_digit($q)) {
            $user = User::find((int) $q);
        }
        if (!$user && str_contains($q, '@')) {
            $user = User::where('email', $q)->first();
            if (!$user) {
                // 支持邮箱片段（例如只记得前缀）
                $user = User::where('email', 'like', '%' . $q . '%')->orderByDesc('id')->first();
            }
        }
        if (!$user) return $this->success(['found' => false, 'query' => $q]);

        $userId = (int) $user->id;

        $orders = DB::table('v2_order as o')
            ->leftJoin('v2_plan as p', 'p.id', '=', 'o.plan_id')
            ->leftJoin('v2_plugin_kc_cards as c', 'c.trade_no', '=', 'o.trade_no')
            ->where('o.user_id', $userId)
            ->orderByDesc('o.id')
            ->limit(10)
            ->get([
                'o.trade_no', 'o.plan_id', 'p.name as plan_name', 'o.total_amount', 'o.balance_amount',
                'o.status', 'o.created_at', 'o.paid_at',
                'c.status as card_status', 'c.kc_status', 'c.kc_progress', 'c.kc_message',
            ]);

        $topups = DB::table('v2_plugin_kc_topups')
            ->where('user_id', $userId)
            ->orderByDesc('id')
            ->limit(10)
            ->get(['trade_no', 'amount', 'status', 'expected_amount', 'received_amount', 'balance_after', 'match_status', 'created_at', 'paid_at']);

        $cards = DB::table('v2_plugin_kc_cards as c')
            ->join('v2_order as o', 'o.trade_no', '=', 'c.trade_no')
            ->where('o.user_id', $userId)
            ->orderByDesc('c.id')
            ->limit(10)
            ->get(['c.trade_no', 'c.plan_type', 'c.status', 'c.kc_status', 'c.kc_message', 'c.error_msg', 'c.attempts', 'c.cdk_code', 'c.updated_at']);

        $afterSales = [];
        try {
            $afterSales = DB::table('v2_plugin_kc_after_sales')
                ->where('user_id', $userId)->orderByDesc('id')->limit(5)
                ->get(['request_no', 'trade_no', 'request_type', 'status', 'created_at']);
        } catch (\Throwable $ignored) {
        }

        $compensations = [];
        try {
            $compensations = DB::table('v2_plugin_kc_compensations')
                ->where('user_id', $userId)->orderByDesc('id')->limit(5)
                ->get(['trade_no', 'compensation_type', 'status', 'amount', 'created_at']);
        } catch (\Throwable $ignored) {
        }

        return $this->success([
            'found' => true,
            'query' => $q,
            'user' => [
                'id' => $userId,
                'email' => (string) $user->email,
                'balance' => (int) $user->balance,
                'banned' => (int) $user->banned,
                'plan_id' => $user->plan_id !== null ? (int) $user->plan_id : null,
                'expired_at' => $user->expired_at !== null ? (int) $user->expired_at : null,
                'created_at' => (int) $user->created_at,
                'last_login_at' => $user->last_login_at !== null ? (int) $user->last_login_at : null,
            ],
            'orders' => $orders->map(fn ($r) => [
                'trade_no' => (string) $r->trade_no,
                'plan_id' => (int) $r->plan_id,
                'plan_name' => (string) ($r->plan_name ?? ''),
                'total_amount' => (int) $r->total_amount,
                'balance_amount' => $r->balance_amount !== null ? (int) $r->balance_amount : null,
                'status' => (int) $r->status,
                'status_cn' => self::ORDER_STATUS_CN[(int) $r->status] ?? ('#' . (int) $r->status),
                'created_at' => (int) $r->created_at,
                'paid_at' => $r->paid_at !== null ? (int) $r->paid_at : 0,
                'card_status' => (string) ($r->card_status ?? ''),
                'kc_status' => (string) ($r->kc_status ?? ''),
                'kc_progress' => $r->kc_progress !== null ? (int) $r->kc_progress : null,
                'kc_message' => (string) ($r->kc_message ?? ''),
            ])->all(),
            'topups' => $topups->map(fn ($r) => [
                'trade_no' => (string) $r->trade_no,
                'amount' => (int) $r->amount,
                'status' => (string) $r->status,
                'status_cn' => self::TOPUP_STATUS_CN[(string) $r->status] ?? (string) $r->status,
                'expected_amount' => (int) $r->expected_amount,
                'received_amount' => (int) $r->received_amount,
                'balance_after' => (int) $r->balance_after,
                'match_status' => (string) $r->match_status,
                'created_at' => (string) $r->created_at,
                'paid_at' => $r->paid_at ? (string) $r->paid_at : '',
            ])->all(),
            'cards' => $cards->map(fn ($r) => [
                'trade_no' => (string) $r->trade_no,
                'plan_type' => (string) $r->plan_type,
                'status' => (string) $r->status,
                'kc_status' => (string) $r->kc_status,
                'kc_message' => (string) ($r->kc_message ?? ''),
                'error_msg' => (string) ($r->error_msg ?? ''),
                'attempts' => (int) $r->attempts,
                'cdk_code' => (string) $r->cdk_code,
                'updated_at' => (string) $r->updated_at,
            ])->all(),
            'after_sales' => $afterSales,
            'compensations' => $compensations,
        ]);
    }

    /**
     * 订单视角聚合：GET /admin/kc/support/order?trade_no=xxx
     * 含实时 KC 任务状态复核（拿不到时降级为本地缓存记录）。
     */
    public function order(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);

        $tradeNo = trim((string) $request->input('trade_no', ''));
        if ($tradeNo === '' || mb_strlen($tradeNo) > 64) return $this->fail([422, '请输入有效订单号']);

        $order = Order::where('trade_no', $tradeNo)->first();
        if (!$order) return $this->success(['found' => false, 'trade_no' => $tradeNo]);

        $planName = (string) (DB::table('v2_plan')->where('id', (int) $order->plan_id)->value('name') ?? '');
        $userEmail = (string) (DB::table('v2_user')->where('id', (int) $order->user_id)->value('email') ?? '');

        $card = DB::table('v2_plugin_kc_cards')->where('trade_no', $tradeNo)->first();
        $topup = DB::table('v2_plugin_kc_topups')->where('trade_no', $tradeNo)->first();

        $afterSales = [];
        try {
            $afterSales = DB::table('v2_plugin_kc_after_sales')
                ->where('trade_no', $tradeNo)->orderByDesc('id')->limit(5)
                ->get(['request_no', 'request_type', 'status', 'created_at']);
        } catch (\Throwable $ignored) {
        }

        $compensation = null;
        try {
            $compensation = DB::table('v2_plugin_kc_compensations')
                ->where('trade_no', $tradeNo)->orderByDesc('id')->first(['compensation_type', 'status', 'amount', 'created_at']);
        } catch (\Throwable $ignored) {
        }

        $live = $this->fetchKcLive($card ? (string) $card->cdk_code : '');

        return $this->success([
            'found' => true,
            'trade_no' => $tradeNo,
            'order' => [
                'trade_no' => (string) $order->trade_no,
                'user_id' => (int) $order->user_id,
                'user_email' => $userEmail,
                'plan_id' => (int) $order->plan_id,
                'plan_name' => $planName,
                'period' => (string) ($order->period ?? ''),
                'total_amount' => (int) $order->total_amount,
                'balance_amount' => $order->balance_amount !== null ? (int) $order->balance_amount : null,
                'status' => (int) $order->status,
                'status_cn' => self::ORDER_STATUS_CN[(int) $order->status] ?? ('#' . (int) $order->status),
                'created_at' => (int) $order->created_at,
                'paid_at' => $order->paid_at !== null ? (int) $order->paid_at : 0,
            ],
            'card' => $card ? [
                'plan_type' => (string) $card->plan_type,
                'status' => (string) $card->status,
                'kc_status' => (string) $card->kc_status,
                'kc_progress' => $card->kc_progress !== null ? (int) $card->kc_progress : null,
                'kc_message' => (string) ($card->kc_message ?? ''),
                'error_msg' => (string) ($card->error_msg ?? ''),
                'attempts' => (int) $card->attempts,
                'cdk_code' => (string) $card->cdk_code,
                'updated_at' => (string) $card->updated_at,
            ] : null,
            'topup' => $topup ? [
                'amount' => (int) $topup->amount,
                'status' => (string) $topup->status,
                'status_cn' => self::TOPUP_STATUS_CN[(string) $topup->status] ?? (string) $topup->status,
                'expected_amount' => (int) $topup->expected_amount,
                'received_amount' => (int) $topup->received_amount,
                'balance_after' => (int) $topup->balance_after,
                'match_status' => (string) $topup->match_status,
                'created_at' => (string) $topup->created_at,
                'paid_at' => $topup->paid_at ? (string) $topup->paid_at : '',
            ] : null,
            'after_sales' => $afterSales,
            'compensation' => $compensation,
            'live' => $live,
        ]);
    }

    /**
     * 实时向 KC 复核任务状态（带集成密钥）。
     * 拿不到时返回 tried=false/ok=false + 通用错误，不抛出。
     */
    protected function fetchKcLive(string $cdk): array
    {
        $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
        $apiKey  = (string) $this->getConfig('integration_key', '');

        if ($cdk === '' || $baseUrl === '' || $apiKey === '') {
            return ['tried' => false, 'ok' => false, 'error' => '未发放卡密或 KC 未配置'];
        }

        try {
            $resp = Http::withHeaders([
                'X-Integration-Key' => $apiKey,
                'Accept'            => 'application/json',
            ])->timeout(3)->connectTimeout(2)->get($baseUrl . '/api/integration/task/status', ['cdk' => $cdk]);
        } catch (\Throwable $e) {
            return ['tried' => true, 'ok' => false, 'error' => 'KC 服务暂时不可达'];
        }

        if ($resp->failed()) {
            return ['tried' => true, 'ok' => false, 'error' => 'KC 返回 HTTP ' . $resp->status()];
        }

        $json = $resp->json();
        if (!is_array($json) || ($json['success'] ?? false) !== true) {
            return ['tried' => true, 'ok' => false, 'error' => 'KC 返回内容异常'];
        }

        $d = $json['data'] ?? [];

        // KC 精确接口实测形态（2026-10-11 取证）：
        //   {"status":"未使用","taskStatus":null,"progress":0,"message":"尚未发起开通","hasTask":false}
        // 中文「status」是主状态字段；taskStatus 只在任务存在时出现。
        $statusCn = (string) ($d['status'] ?? $d['status_cn'] ?? '');
        $stateMap = [
            '未使用' => 'available', '冷却中' => 'cooldown', '开通中' => 'processing',
            '已完成' => 'completed', '已使用' => 'used', '已过期' => 'expired',
            '已冻结' => 'frozen', '开通失败' => 'failed', '待人工处理' => 'manual', '未找到' => 'not_found',
        ];
        $cdkState = (string) ($d['cdk_state'] ?? $d['state'] ?? '');
        if ($cdkState === '' && isset($stateMap[$statusCn])) {
            $cdkState = $stateMap[$statusCn];
        }

        return [
            'tried'       => true,
            'ok'          => true,
            'cdk_state'   => $cdkState,
            'status_cn'   => $statusCn,
            'task_status' => (string) ($d['taskStatus'] ?? ''),
            'progress'    => is_numeric($d['progress'] ?? null) ? (int) $d['progress'] : null,
            'message'     => (string) ($d['message'] ?? ''),
            'next_action' => (string) ($d['next_action'] ?? ''),
        ];
    }
}
