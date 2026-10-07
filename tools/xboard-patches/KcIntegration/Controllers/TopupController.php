<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use App\Models\Order;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
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
 * 套餐复用策略：
 *   同金额且**没有未支付订单占用**的充值套餐直接复用，避免套餐表泛滥。
 *   复用判定与订单占用的竞态是无害的（最多多建一行套餐）。
 *
 * ⚠️ 价格与到账金额必须同一条 UPDATE/INSERT 落库（prices 与 kc_topup_amount
 *   永远成对写入），否则会出现「按 A 价格付款、按 B 金额到账」的资损窗口。
 */
class TopupController extends PluginController
{
    /** 自定义充值金额上下限（分） */
    private const MIN_AMOUNT = 1000;     // ¥10
    private const MAX_AMOUNT = 500000;   // ¥5000

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
            return $this->fail([400, '充值金额需为整数元']);
        }

        $userId = (int) $request->user()->id;

        $risk = (new RiskService())->guardTopup($request, $userId);
        if (!$risk['allowed']) {
            return $this->fail($this->riskFailure($risk));
        }

        try {
            $planId = DB::transaction(function () use ($amount, $userId) {
                // 复用：同金额、未满员、且当前没有未支付订单占用的充值套餐
                $existing = DB::selectOne(
                    'SELECT p.id FROM `v2_plan` p
                      WHERE p.kc_is_topup = 1
                        AND p.kc_topup_amount = ?
                        AND p.show = 1
                        AND NOT EXISTS (
                            SELECT 1 FROM `v2_order` o
                             WHERE o.plan_id = p.id AND o.status = 0
                        )
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
                    'name'                 => '余额充值 ¥' . $yuan,
                    'prices'               => json_encode(['onetime' => $yuan]),
                    'sell'                 => 1,
                    'show'                 => 1,
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
                'plan_id' => $planId,
                'amount'  => $amount,
                'period'  => 'onetime',
            ]);
        } catch (\Throwable $e) {
            Log::channel('daily')->error('[KcIntegration] 充值套餐准备失败: ' . $e->getMessage());
            return $this->fail([500, '充值初始化失败，请稍后重试']);
        }
    }

    /**
     * 查询某笔订单的充值信息（订单页展示「已充值 ¥X 到余额」）。
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
        ]);
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
