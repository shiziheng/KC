<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use App\Models\Order;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Plugin\KcIntegration\Models\KcTopup;
use Plugin\KcIntegration\Services\RiskService;
use Plugin\KcIntegration\Services\TopupService;

/**
 * 前台充值控制器（FEAT-004 · D3）—— 需要登录（'user' 中间件）
 *
 * 为什么需要 prepare 接口：
 *   Xboard 的订单金额来自 plan.prices，不可在下单时传自定义金额。
 *   「自由输入金额」的做法是：把用户输入的金额落成一个**一次性充值套餐**
 *   （kc_is_topup=1 + kc_topup_amount=金额分 + prices.onetime=金额元），
 *   返回 plan_id，前台随后走原生 save→checkout 下单支付，履约复用 D2 钩子。
 *
 * 套餐复用策略（FEAT-014 修订）：
 *   同金额充值套餐**一律复用**（capacity_limit=NULL 本就不限量）。
 *   旧实现带 `NOT EXISTS (status=0 的未支付订单)`，导致用户只要有一笔未支付充值单，
 *   后续充值就会不断新建套餐 —— 这既是「有进行中订单就不能充值」的根因，
 *   也让 v2_plan 迅速膨胀。该判断没有任何防超发价值，已移除。
 *
 * ⚠️ 价格与到账金额必须同一条 UPDATE/INSERT 落库（prices 与 kc_topup_amount
 *   永远成对写入），否则会出现「按 A 价格付款、按 B 金额到账」的资损窗口。
 *
 * ── FEAT-014 增强 ──────────────────────────────────────────────
 * 1. 允许并发发起充值订单（同金额套餐一律复用，不再被未支付单阻塞）
 * 2. 充值订单有效期 ORDER_TTL_SECONDS（默认 30 分钟），超时失效、可重新发起
 * 3. 新增台账接口 orders()：按 pending / overdue / done / failed 分组返回
 */
class TopupController extends PluginController
{
    /** 自定义充值金额上下限（分 · 美元） */
    private const MIN_AMOUNT = 100;      // $1
    private const MAX_AMOUNT = 50000;    // $500

    /**
     * 充值订单有效期（秒）。到期未支付 → 失效。
     * 30 分钟覆盖「发起充值 → 收银台付款」的正常时长；USDT 链上确认本身要几分钟，
     * 定得太短会让正常用户付不上。失效后用户可直接再发起一笔（已放开并发）。
     */
    private const ORDER_TTL_SECONDS = 1800;

    /**
     * 准备充值套餐。
     * POST /user/kc/topup/prepare  {amount: 分}
     */
    public function prepare(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $request->validate([
            'amount' => 'required|integer|min:' . self::MIN_AMOUNT . '|max:' . self::MAX_AMOUNT,
        ]);

        $amount = (int) $request->input('amount'); // 分
        if ($amount % 100 !== 0) {
            return $this->fail([400, '充值金额需为整数美元']);
        }

        $userId = (int) $request->user()->id;

        $risk = (new RiskService())->guardTopup($request, $userId);
        if (!$risk['allowed']) {
            return $this->fail($this->riskFailure($risk));
        }

        try {
            $planId = DB::transaction(function () use ($amount, $userId) {
                // FEAT-014：同金额套餐**一律复用**（capacity_limit=NULL 不限量）。
                // 移除旧的「未支付订单占用」判断 —— 它是「有进行中订单就不能充值」的根因，
                // 套餐本来不限量，该判断既无防超发价值，又会每次新建脏套餐。
                $existing = DB::selectOne(
                    'SELECT p.id FROM `v2_plan` p
                      WHERE p.kc_is_topup = 1
                        AND p.kc_topup_amount = ?
                      /* KC-PATCH2: show 不限 */
                      ORDER BY p.id ASC LIMIT 1',
                    [$amount]
                );
                if ($existing) {
                    return (int) $existing->id;
                }

                // 新建：prices（元）与 kc_topup_amount（分）必须成对写入；
                // capacity_limit 必须 NULL（=不限量），默认值 0 会直接「售罄」拒买
                $yuan = intdiv($amount, 100);
                $gid  = (int) (DB::table('v2_plan')->orderBy('id')->value('group_id') ?: 1);
                $now  = time();

                return (int) DB::table('v2_plan')->insertGetId([
                    'group_id'             => $gid,
                    'transfer_enable'      => 0,
                    'name'                 => '余额充值 $' . $yuan,
                    'prices'               => json_encode(['onetime' => $yuan]),
                    'sell'                 => 1,
                    'show'                 => 0, // KC-PATCH2: 默认隐藏自商品页
                    'kc_is_topup'          => 1,
                    'kc_topup_amount'      => $amount,
                    'capacity_limit'       => null,
                    'sort'                 => 999,
                    'renew'                => 0,
                    'content'              => '自定义金额余额充值（系统生成）',
                    'reset_traffic_method' => 0,
                    'created_at'           => $now,
                    'updated_at'           => $now,
                ]);
            });

            Log::channel('daily')->info('[KcIntegration] 充值套餐已准备', [
                'user_id' => $userId, 'plan_id' => $planId, 'amount' => $amount,
            ]);

            return $this->success([
                'plan_id'    => $planId,
                'amount'     => $amount,
                'period'     => 'onetime',
                // 前端据此倒计时；到期订单失效，可直接重新发起（不再阻塞）
                'expires_in' => self::ORDER_TTL_SECONDS,
            ]);
        } catch (\Throwable $e) {
            Log::channel('daily')->error('[KcIntegration] 充值套餐准备失败: ' . $e->getMessage());
            return $this->fail([500, '充值初始化失败，请稍后重试']);
        }
    }

    /**
     * 查询某笔订单的充值信息（订单页展示「已充值 $X 到余额」；全站金额一律美元计价）。
     * GET /user/kc/topup/info?trade_no=xxx
     */
    public function info(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $request->validate([
            'trade_no' => 'required|string|max:64',
        ]);
        $tradeNo = (string) $request->input('trade_no');

        $order = Order::where('trade_no', $tradeNo)
            ->where('user_id', $request->user()->id)
            ->first();
        if (!$order) {
            return $this->fail([400, '订单不存在']);
        }

        $service = new TopupService();
        $row = $service->find($tradeNo);

        return $this->success([
            'trade_no'      => $tradeNo,
            'is_topup'      => $service->isTopupPlan((int) $order->plan_id),
            'order_status'  => (int) $order->status,
            'status'        => $row ? (string) $row->status : '',
            'amount'        => $row ? (int) $row->amount : 0,
            'balance_after' => $row ? (int) $row->balance_after : 0,
            'expires_at'    => ($row && !empty($row->expires_at)) ? (int) $row->expires_at : 0,
            'payment_reference' => $row ? (string) ($row->payment_reference ?? '') : '',
            'expected_amount' => $row ? (int) ($row->expected_amount ?? 0) : 0,
            'received_amount' => $row ? (int) ($row->received_amount ?? 0) : 0,
            'chain' => $row ? (string) ($row->chain ?? 'TRC20') : 'TRC20',
            'match_status' => $row ? (string) ($row->match_status ?? 'pending') : 'pending',
        ]);
    }

    /**
     * 充值订单台账（FEAT-014）—— 前台充值面板展示 + 后台对账依据。
     * GET /user/kc/topup/orders
     *
     * 按状态分组返回当前用户的充值订单（最多 100 条）：
     *   pending  待支付（未超时）
     *   overdue  待支付但**已超时失效**（不阻塞新单，用户可重新发起）
     *   done     已到账
     *   failed   处理失败
     *
     * 说明：台账表 v2_plugin_kc_topups 的行在**支付成功回调**时才写入（TopupService::apply）。
     * 未支付订单没有台账行，为避免漏展示，这里以 v2_order 为主表 LEFT JOIN 台账，
     * 这样「刚发起还没付」的订单也能在台账里看到（status=pending + 有效期）。
     */
    public function orders(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }

        $userId = (int) $request->user()->id;
        $now = time();

        try {
            // 以订单为主表 LEFT JOIN 台账：未支付订单（无台账行）也能展示
            $rows = DB::table('v2_order as o')
                ->leftJoin('v2_plugin_kc_topups as t', 't.trade_no', '=', 'o.trade_no')
                ->leftJoin('v2_plan as p', 'p.id', '=', 'o.plan_id')
                ->where('o.user_id', $userId)
                ->whereIn('o.plan_id', function ($q) {
                    $q->select('id')->from('v2_plan')->where('kc_is_topup', 1);
                })
                ->orderByDesc('o.created_at')
                ->limit(100)
                ->get([
                    'o.trade_no', 'o.plan_id', 'o.status as order_status',
                    'o.total_amount', 'o.created_at', 'o.paid_at',
                    't.amount as topup_amount', 't.status as topup_status',
                    't.balance_after', 't.error_msg', 't.attempts', 't.expires_at',
                    't.payment_reference', 't.expected_amount', 't.received_amount', 't.chain', 't.tx_hash', 't.confirmations', 't.match_status', 't.payment_source',
                    'p.kc_topup_amount',
                ]);

            $list = [];
            foreach ($rows as $r) {
                $orderStatus = (int) $r->order_status;
                // 金额三取一：台账行 > 套餐配置 > 订单总额（未支付单没有台账行，必须靠套餐兜底）
                $amount = (int) ($r->topup_amount ?: ($r->kc_topup_amount ?: $r->total_amount));

                // 状态推导：台账优先（已到账/失败），否则看订单状态
                if ($r->topup_status === 'done') {
                    $status = 'done';
                } elseif ($r->topup_status === 'failed') {
                    $status = 'failed';
                } elseif ($orderStatus === 0 || $orderStatus === 1) {
                    // 0=待支付 1=处理中 → 未到账
                    $status = 'pending';
                } else {
                    // 订单已取消(2)/已完成(3)但无台账行 → 视为失效
                    $status = 'overdue';
                }

                // 有效期：到账的订单不受有效期约束
                $expiresAt = $r->expires_at ? (int) $r->expires_at : 0;
                if ($status === 'pending' && $expiresAt === 0) {
                    // 无 expires_at 的历史数据：按下单时间 + TTL 推算
                    $expiresAt = (int) $r->created_at + self::ORDER_TTL_SECONDS;
                }
                if ($status === 'pending' && $expiresAt > 0 && $expiresAt < $now) {
                    $status = 'overdue';
                }

                $list[] = [
                    'trade_no'      => $r->trade_no,
                    'plan_id'       => (int) $r->plan_id,
                    'amount'        => $amount,
                    'status'        => $status,
                    'balance_after' => $r->balance_after !== null ? (int) $r->balance_after : 0,
                    'error_msg'     => (string) ($r->error_msg ?: ''),
                    'attempts'      => (int) ($r->attempts ?: 0),
                    'created_at'    => (int) $r->created_at,
                    'paid_at'       => $r->paid_at ? (int) $r->paid_at : 0,
                    'expires_at'    => $expiresAt,
                    'expired'       => $status === 'overdue',
                    'payment_reference' => (string) ($r->payment_reference ?: ''),
                    'expected_amount' => (int) ($r->expected_amount ?: 0),
                    'received_amount' => (int) ($r->received_amount ?: 0),
                    'chain' => (string) ($r->chain ?: 'TRC20'),
                    'tx_hash' => (string) ($r->tx_hash ?: ''),
                    'confirmations' => (int) ($r->confirmations ?: 0),
                    'match_status' => (string) ($r->match_status ?: ($status === 'done' ? 'credited' : 'pending')),
                    'payment_source' => (string) ($r->payment_source ?: ''),
                ];
            }

            $groups = ['pending' => [], 'overdue' => [], 'done' => [], 'failed' => []];
            foreach ($list as $item) {
                $groups[$item['status']][] = $item;
            }

            return $this->success([
                'orders' => $list,
                'groups' => $groups,
                'ttl'    => self::ORDER_TTL_SECONDS,
            ]);
        } catch (\Throwable $e) {
            Log::channel('daily')->error('[KcIntegration] 充值订单台账读取失败: ' . $e->getMessage());
            return $this->fail([500, '充值订单读取失败，请稍后重试']);
        }
    }

    /**
     * 管理员充值异常队列（Xboard 独立后台使用）。只返回可核对字段，不返回任何支付密钥。
     */
    public function adminList(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);

        $query = DB::table('v2_plugin_kc_topups as t')
            ->leftJoin('v2_user as u', 'u.id', '=', 't.user_id')
            ->orderByDesc('t.id')->limit(200);
        if ($request->filled('trade_no')) $query->where('t.trade_no', 'like', '%' . substr((string) $request->input('trade_no'), 0, 64) . '%');
        if ($request->filled('payment_reference')) $query->where('t.payment_reference', substr((string) $request->input('payment_reference'), 0, 32));
        if ($request->filled('user_id')) $query->where('t.user_id', (int) $request->input('user_id'));
        if ($request->filled('status')) $query->where('t.status', substr((string) $request->input('status'), 0, 16));
        if ($request->filled('match_status')) $query->where('t.match_status', substr((string) $request->input('match_status'), 0, 32));

        $rows = $query->get([
            't.id', 't.trade_no', 't.user_id', 'u.email as user_email', 't.amount', 't.status',
            't.balance_before', 't.balance_after', 't.payment_reference', 't.expected_amount', 't.received_amount',
            't.chain', 't.wallet_address', 't.tx_hash', 't.confirmations', 't.match_status', 't.payment_source',
            't.manual_reason', 't.operator_ref', 't.error_msg', 't.attempts', 't.expires_at', 't.paid_at', 't.created_at'
        ]);

        return $this->success(['orders' => $rows->map(fn ($r) => (array) $r)->all()]);
    }

    /**
     * 管理员补单：必须有链上交易哈希、到账金额和原因；余额变更仍走 TopupService + LedgerService。
     */
    public function adminCredit(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);

        $tradeNo = trim((string) $request->input('trade_no'));
        $txHash = trim((string) $request->input('tx_hash'));
        $reason = trim((string) $request->input('reason'));
        $received = (int) $request->input('received_amount', 0);
        $confirmations = (int) $request->input('confirmations', 0);
        if ($tradeNo === '' || $txHash === '' || $reason === '' || $received <= 0) {
            return $this->fail([422, '订单号、交易哈希、到账金额和补单原因均不能为空']);
        }
        if (mb_strlen($reason) < 4) return $this->fail([422, '补单原因至少 4 个字符']);
        if (DB::table('v2_plugin_kc_topups')->where('tx_hash', $txHash)->where('trade_no', '<>', $tradeNo)->exists()) {
            return $this->fail([409, '该交易哈希已经关联其他充值订单']);
        }

        $order = Order::where('trade_no', $tradeNo)->first();
        if (!$order) return $this->fail([404, '充值订单不存在']);
        $service = new TopupService();
        $amount = $service->resolveAmount((int) $order->plan_id);
        if (!$service->isTopupPlan((int) $order->plan_id) || $amount <= 0) {
            return $this->fail([400, '该订单不是有效的余额充值订单']);
        }

        $row = $service->find($tradeNo);
        $details = TopupService::paymentDetails($amount, $tradeNo);
        if (!$row) {
            $service->ensurePaymentDraft($tradeNo, (int) $order->user_id, $amount, $details['expected_amount'], $details['payment_reference']);
            $row = $service->find($tradeNo);
        }
        if (!$row) return $this->fail([500, '充值台账创建失败']);
        if ((string) $row->status === KcTopup::STATUS_DONE) {
            // 已完成订单保持原始核验信息，不允许再次补单覆盖交易哈希。
            return $this->success([
                'trade_no' => $tradeNo,
                'amount' => $amount,
                'received_amount' => (int) ($row->received_amount ?? 0),
                'skipped' => true,
                'status' => 'credited',
            ]);
        }
        if ((int) $row->expected_amount > 0 && $received < (int) $row->expected_amount) {
            return $this->fail([422, '实际到账金额低于预计金额，已保留在异常队列，不能直接补足余额']);
        }

        $operator = (string) ($request->user()?->email ?: 'xboard-admin:' . (int) ($request->user()?->id ?? 0));
        $service->markPayment($tradeNo, $received, $txHash, $confirmations, 'verified', 'manual', $reason, $operator);
        $result = $service->apply($tradeNo, (int) $order->user_id, $amount, 'manual', $operator, [
            'tx_hash' => $txHash,
            'received_amount' => $received,
            'confirmations' => $confirmations,
            'reason' => $reason,
        ]);
        if (!$result['ok']) return $this->fail([500, '补单失败：' . $result['error']]);

        $fresh = Order::where('trade_no', $tradeNo)->first();
        if ($fresh && (int) $fresh->status === Order::STATUS_PENDING) {
            $fresh->status = Order::STATUS_COMPLETED;
            $fresh->paid_at = time();
            $fresh->callback_no = $txHash;
            $fresh->save();
        }
        return $this->success([
            'trade_no' => $tradeNo,
            'amount' => $amount,
            'received_amount' => $received,
            'skipped' => (bool) $result['skipped'],
            'status' => 'credited',
        ]);
    }

    /** 标记少付、错链、过期等异常，不改变余额。 */
    public function adminMarkReview(Request $request)
    {
        if ($error = $this->beforePluginAction()) return $this->fail($error);
        $tradeNo = trim((string) $request->input('trade_no'));
        $reason = trim((string) $request->input('reason'));
        if ($tradeNo === '' || $reason === '') return $this->fail([422, '订单号和异常原因不能为空']);
        $operator = (string) ($request->user()?->email ?: 'xboard-admin:' . (int) ($request->user()?->id ?? 0));
        $service = new TopupService();
        $existing = $service->find($tradeNo);
        if (!$existing) return $this->fail([404, '充值订单不存在']);
        if ((string) $existing->status === KcTopup::STATUS_DONE) return $this->fail([409, '充值已到账，不能再标记为异常']);
        $row = $service->markPayment($tradeNo, (int) $request->input('received_amount', 0), trim((string) $request->input('tx_hash')), (int) $request->input('confirmations', 0), 'manual_review', 'manual', $reason, $operator);
        if (!$row) return $this->fail([404, '充值订单不存在']);
        return $this->success(['trade_no' => $tradeNo, 'status' => 'manual_review']);
    }

    /** 风控拒绝使用统一、无供应商细节的前台文案。 */
    protected function riskFailure(array $risk): array
    {
        $action = (string) ($risk['action'] ?? 'block');
        if ($action === 'manual') return [403, '当前请求需要人工核验，请联系客服'];
        if ($action === 'challenge') return [429, '请求需要进一步验证，请稍后重试或联系客服'];
        return [429, '操作过于频繁，请稍后再试'];
    }
}
