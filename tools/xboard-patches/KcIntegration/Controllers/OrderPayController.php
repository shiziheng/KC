<?php

namespace Plugin\KcIntegration\Controllers;

use App\Http\Controllers\PluginController;
use App\Models\Order;
use App\Services\OrderService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * 余额结算控制器（FEAT-010）
 *
 * 背景：Xboard 原生把「余额」当抵扣券——OrderController::handleUserBalance 只改金额
 *      （balance_amount=total、total_amount=0），**不改订单状态**，订单仍是待支付，
 *      因此不会触发履约与发卡。要让「纯余额支付」成立，需要在余额已全额抵扣后
 *      把订单推进到履约：本接口调用 OrderService::paid()（PENDING→PROCESSING +
 *      同步派发 OrderHandleJob → 触发原生履约与 order.open.after 发卡）。
 *
 * 安全约束：
 *   1) 必须登录（路由挂 user 中间件）
 *   2) 订单必须属于当前用户
 *   3) 仅接受「余额已全额抵扣」的订单：total_amount === 0 且 balance_amount > 0
 *      —— 避免被用来「零元购」未经余额抵扣的订单
 *   4) 幂等：非 PENDING 状态直接返回 already（paid() 内部也有状态守卫）
 *
 * 路由：POST /kc/order/pay-balance  {trade_no}
 */
class OrderPayController extends PluginController
{
    public function payBalance(Request $request)
    {
        if ($error = $this->beforePluginAction()) {
            return $this->fail($error);
        }
        if ($error = $this->ensureSameOrigin($request)) {
            return $this->fail($error);
        }

        $request->validate([
            'trade_no' => 'required|string|max:64',
        ]);

        $tradeNo = (string) $request->input('trade_no');
        $userId  = (int) $request->user()->id;

        $order = Order::where('trade_no', $tradeNo)->where('user_id', $userId)->first();
        if (!$order instanceof Order) {
            return $this->fail([400, '订单不存在或无权访问']);
        }

        if ((int) $order->status !== Order::STATUS_PENDING) {
            return $this->success([
                'status'  => 'already',
                'message' => '订单已在处理中或已完成',
            ]);
        }

        // 仅允许余额已全额抵扣的订单
        if ((int) $order->total_amount !== 0 || (int) $order->balance_amount <= 0) {
            return $this->fail([400, '该订单未完成余额抵扣，无法用余额结算']);
        }

        try {
            $service = new OrderService($order);
            $ok = $service->paid('BALANCE-' . $tradeNo);
        } catch (\Throwable $e) {
            Log::channel('daily')->error('[KcIntegration] 余额结算异常: ' . $e->getMessage(), [
                'trade_no' => $tradeNo,
            ]);
            return $this->fail([500, '余额结算失败，请稍后重试']);
        }

        if (!$ok) {
            return $this->fail([500, '余额结算失败，请稍后重试']);
        }

        Log::channel('daily')->info('[KcIntegration] 余额结算完成', [
            'trade_no' => $tradeNo,
            'user_id'  => $userId,
            'amount'   => (int) $order->balance_amount,
        ]);

        return $this->success([
            'status'  => 'paid',
            'message' => '已用余额完成支付',
        ]);
    }

    /**
     * 同源校验（与兑卡控制器同款）：浏览器跨站请求一定带 Origin，非浏览器请求放行。
     *
     * @return array|null [状态码, 消息] 或 null 表示通过
     */
    protected function ensureSameOrigin(Request $request): ?array
    {
        $origin = (string) $request->headers->get('Origin', '');
        if ($origin === '') {
            return null;
        }
        $host = $request->getSchemeAndHttpHost();
        if (!hash_equals($host, rtrim($origin, '/'))) {
            $appUrl = rtrim((string) admin_setting('app_url', ''), '/');
            if ($appUrl === '' || !hash_equals($appUrl, rtrim($origin, '/'))) {
                Log::channel('daily')->warning('[KcIntegration] 余额结算拒绝跨站请求', [
                    'origin' => $origin,
                    'host'   => $host,
                ]);
                return [403, '请求来源不合法'];
            }
        }
        return null;
    }
}
