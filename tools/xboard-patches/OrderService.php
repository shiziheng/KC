<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Jobs\OrderHandleJob;
use App\Models\Order;
use App\Models\Plan;
use App\Models\TrafficResetLog;
use App\Models\User;
use App\Services\Plugin\HookManager;
use App\Utils\Helper;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Carbon\Carbon;
use App\Services\PlanService;

class OrderService
{
    const STR_TO_TIME = [
        Plan::PERIOD_MONTHLY => 1,
        Plan::PERIOD_QUARTERLY => 3,
        Plan::PERIOD_HALF_YEARLY => 6,
        Plan::PERIOD_YEARLY => 12,
        Plan::PERIOD_TWO_YEARLY => 24,
        Plan::PERIOD_THREE_YEARLY => 36
    ];
    public $order;
    public $user;

    public function __construct(Order $order)
    {
        $this->order = $order;
    }

    private function lockCurrentOrder(): ?Order
    {
        return Order::whereKey($this->order->id)
            ->lockForUpdate()
            ->first();
    }

    private function lockCurrentOrderWhenStatus(int $status): ?Order
    {
        return Order::whereKey($this->order->id)
            ->where('status', $status)
            ->lockForUpdate()
            ->first();
    }

    /**
     * Create an order from a request.
     *
     * @param User $user
     * @param Plan $plan
     * @param string $period
     * @param string|null $couponCode
     * @return Order
     * @throws ApiException
     */
    public static function createFromRequest(
        User $user,
        Plan $plan,
        string $period,
        ?string $couponCode = null,
    ): Order {
        $userService = app(UserService::class);
        $planService = new PlanService($plan);

        $planService->validatePurchase($user, $period);
        HookManager::call('order.create.before', [$user, $plan, $period, $couponCode]);

        return DB::transaction(function () use ($user, $plan, $period, $couponCode, $userService) {
            $user = User::lockForUpdate()->find($user->id);
            if (!$user) {
                throw new ApiException(__('The user does not exist'));
            }

                    // KC-PATCH:ALLOW-CONCURRENT-ORDERS —— 允许同时存在多笔未支付/处理中订单（2026-10-13 产品决策）
        // 原规则：只要存在 status in (0,1) 的订单就禁止再下单（提示「您有未付款或开通中的订单」）。
        //        该规则与插件侧充值已移除的同类限制口径不一致；套餐不占库存、无防超发价值，
        //        且待支付订单 30 分钟自动失效，保留它只会挡住正常复购与支付失败后的重开。
        //        仅放开【用户侧下单】；管理员分配侧（V2/Admin/OrderController）保持原样。
if (false && $userService->isNotCompleteOrderByUserId($user->id)) {
                throw new ApiException(__('You have an unpaid or pending order, please try again later or cancel it'));
            }

            $newPeriod = PlanService::getPeriodKey($period);

            $order = new Order([
                'user_id' => $user->id,
                'plan_id' => $plan->id,
                'period' => $newPeriod,
                'trade_no' => Helper::generateOrderNo(),
                'total_amount' => (int) (optional($plan->prices)[$newPeriod] * 100),
            ]);

            $orderService = new self($order);

            // KC-PATCH:ENTITLEMENT-PRICE —— 代充按「用户权益价」结算（Step 7 接线）
            // 在套用优惠券 / 会员折扣 / 余额抵扣之前改写本单金额，使其仍走原生余额结算链路。
            // 任何异常 / 超时 / KC 不可达一律保持原价，绝不阻断下单。
            $orderService->kcApplyEntitlementPrice($plan);

            if ($couponCode) {
                $orderService->applyCoupon($couponCode);
            }

            $orderService->setVipDiscount($user);
            $orderService->setOrderType($user);

            if ($user->balance && $order->total_amount > 0) {
                $orderService->handleUserBalance($user, $userService);
            }

            $orderService->setInvite(user: $user);

            if (!$order->save()) {
                throw new ApiException(__('Failed to create order'));
            }

            HookManager::call('order.create.after', $order);
            // 兼容旧钩子
            HookManager::call('order.after_create', $order);

            return $order;
        });
    }

    public function open(): void
    {
        $openedOrder = DB::transaction(function () {
            $order = $this->lockCurrentOrderWhenStatus(Order::STATUS_PROCESSING);
            if (!$order) {
                return null;
            }

            $plan = Plan::find($order->plan_id);
            if (!$plan) {
                throw new \RuntimeException('订阅不存在');
            }

            HookManager::call('order.open.before', $order);

            // KC-PATCH:ENTITLEMENT-PACK —— 权益包商品（v2_plan.kc_card.category='entitlement'）
            // 只把订单推进到 COMPLETED，**不进入订阅开通链路**：
            //   权益包不是订阅，绝不能覆写用户的 plan_id / expired_at，
            //   也不应产生流量重置、限速、设备数等副作用。
            //   真正的权益发放由 KcIntegration 插件在 order.open.after 钩子里调 KC 集成端点完成。
            if ($this->kcIsEntitlementPlan((int) $order->plan_id)) {
                $order->status = Order::STATUS_COMPLETED;
                if (!$order->save()) {
                    throw new \RuntimeException('订单信息保存失败');
                }
                return $order;
            }

            $this->user = User::lockForUpdate()->find($order->user_id);

            if ($order->surplus_credit) {
                $this->user->balance += $order->surplus_credit;
            }

            if ($order->surplus_order_ids) {
                Order::whereIn('id', $order->surplus_order_ids)
                    ->update(['status' => Order::STATUS_DISCOUNTED]);
            }

            match ((string) $order->period) {
                Plan::PERIOD_ONETIME => $this->buyByOneTime($plan),
                Plan::PERIOD_RESET_TRAFFIC => app(TrafficResetService::class)->performReset($this->user, TrafficResetLog::SOURCE_ORDER),
                default => $this->buyByPeriod($order, $plan),
            };

            $this->setSpeedLimit($plan->speed_limit);
            $this->setDeviceLimit($plan->device_limit);

            if (!$this->user->save()) {
                throw new \RuntimeException('用户信息保存失败');
            }

            $order->status = Order::STATUS_COMPLETED;
            if (!$order->save()) {
                throw new \RuntimeException('订单信息保存失败');
            }

            return $order;
        });

        if (!$openedOrder) {
            return;
        }

        $order = $openedOrder;
        $this->order = $order;

        $eventId = match ((int) $order->type) {
            Order::TYPE_NEW_PURCHASE => admin_setting('new_order_event_id', 0),
            Order::TYPE_RENEWAL => admin_setting('renew_order_event_id', 0),
            Order::TYPE_UPGRADE => admin_setting('change_order_event_id', 0),
            default => 0,
        };

        if ($eventId) {
            $this->openEvent($eventId);
        }

        HookManager::call('order.open.after', $order);
    }


    public function setOrderType(User $user)
    {
        $order = $this->order;
        if ($order->period === Plan::PERIOD_RESET_TRAFFIC) {
            $order->type = Order::TYPE_RESET_TRAFFIC;
        } else if ($user->plan_id !== NULL && $order->plan_id !== $user->plan_id && ($user->expired_at > time() || $user->expired_at === NULL)) {
            if (!(int) admin_setting('plan_change_enable', 1))
                throw new ApiException('目前不允许更改订阅，请联系客服或提交工单操作');
            $order->type = Order::TYPE_UPGRADE;
            if ((int) admin_setting('surplus_enable', 1))
                $this->getSurplusValue($user, $order);
            if ($order->surplus_amount >= $order->total_amount) {
                $order->surplus_credit = (int) ($order->surplus_amount - $order->total_amount);
                $order->total_amount = 0;
            } else {
                $order->total_amount = (int) ($order->total_amount - $order->surplus_amount);
            }
        } else if (($user->expired_at === null || $user->expired_at > time()) && $order->plan_id == $user->plan_id) { // 用户订阅未过期或按流量订阅 且购买订阅与当前订阅相同 === 续费
            $order->type = Order::TYPE_RENEWAL;
        } else { // 新购
            $order->type = Order::TYPE_NEW_PURCHASE;
        }
    }

    public function setVipDiscount(User $user)
    {
        $order = $this->order;
        if ($user->discount) {
            $order->discount_amount = $order->discount_amount + ($order->total_amount * ($user->discount / 100));
        }
        $order->total_amount = $order->total_amount - $order->discount_amount;
    }

    public function setInvite(User $user): void
    {
        $order = $this->order;
        if ($user->invite_user_id && ($order->total_amount <= 0))
            return;
        $order->invite_user_id = $user->invite_user_id;
        $inviter = User::find($user->invite_user_id);
        if (!$inviter)
            return;
        $commissionType = (int) $inviter->commission_type;
        if ($commissionType === User::COMMISSION_TYPE_SYSTEM) {
            $commissionType = (bool) admin_setting('commission_first_time_enable', true) ? User::COMMISSION_TYPE_ONETIME : User::COMMISSION_TYPE_PERIOD;
        }
        $isCommission = false;
        switch ($commissionType) {
            case User::COMMISSION_TYPE_PERIOD:
                $isCommission = true;
                break;
            case User::COMMISSION_TYPE_ONETIME:
                $isCommission = !$this->haveValidOrder($user);
                break;
        }

        if (!$isCommission)
            return;

        // ────────────────────────────────────────────────────────────────
        // KC-PATCH：充值套餐返佣**由后台配置控制**（不写死）
        //
        // 配置位置：Xboard 后台 → 插件 → 「KC 代充集成」→ 充值套餐返佣比例(%)
        //   = 0（默认）：充值不返佣。原因：平台鼓励用户充值（预收资金），
        //              若充值也返佣，会出现「先充值再消费」把返利放大的路径，
        //              且与「充值是为了减少支付摩擦」的定位冲突。
        //   > 0        ：按该比例给充值订单返佣 —— 想放开时**改配置即可，无需改代码**。
        //
        // 普通商品套餐**不受此项影响**，仍按上面的系统分销设置执行。
        // 配置读不到时降级为 0（不返佣），且不中断原有返利逻辑。
        // ────────────────────────────────────────────────────────────────
        if ($this->kcIsTopupPlan((int) $order->plan_id)) {
            $topupRate = $this->kcTopupCommissionRate();
            if ($topupRate <= 0) {
                return;
            }
            $order->commission_balance = $order->total_amount * ($topupRate / 100);
            return;
        }

        if ($inviter->commission_rate) {
            $order->commission_balance = $order->total_amount * ($inviter->commission_rate / 100);
        } else {
            $order->commission_balance = $order->total_amount * (admin_setting('invite_commission', 10) / 100);
        }
    }

    /**
     * KC-PATCH：读取「充值套餐返佣比例(%)」。
     *
     * 读取顺序：
     *   ① 插件配置 v2_plugins.config.topup_commission_rate（后台插件页可改，主入口）
     *   ② v2_settings.kc_topup_commission_rate（备用，可用脚本设置）
     *   ③ 0（默认 = 充值不返佣）
     *
     * 任何异常都返回 0，确保不因读取失败而给充值订单错误返佣。
     */
    private function kcTopupCommissionRate(): int
    {
        // ① 插件配置（后台插件页）
        try {
            if (\Illuminate\Support\Facades\Schema::hasTable('v2_plugins')) {
                $json = \Illuminate\Support\Facades\DB::table('v2_plugins')
                    ->where('code', 'kc_integration')
                    ->value('config');
                if ($json) {
                    $cfg = json_decode((string) $json, true);
                    if (is_array($cfg) && isset($cfg['topup_commission_rate']) && $cfg['topup_commission_rate'] !== '') {
                        return max(0, (int) $cfg['topup_commission_rate']);
                    }
                }
            }
        } catch (\Throwable $e) {
            // 继续走备用
        }

        // ② v2_settings 备用
        try {
            return max(0, (int) admin_setting('kc_topup_commission_rate', 0));
        } catch (\Throwable $e) {
            return 0;
        }
    }

    /**
     * KC-PATCH：判断是否为「权益包」商品（v2_plan.kc_card.category='entitlement'）。
     * 任何异常都返回 false（降级放行），确保不因配置缺失而中断正常履约。
     */
    private function kcIsEntitlementPlan(int $planId): bool
    {
        if ($planId <= 0) {
            return false;
        }
        try {
            $raw = \Illuminate\Support\Facades\DB::table('v2_plan')->where('id', $planId)->value('kc_card');
            if (empty($raw)) {
                return false;
            }
            $card = is_string($raw) ? json_decode($raw, true) : (is_array($raw) ? $raw : null);
            if (!is_array($card)) {
                return false;
            }
            return (string) ($card['category'] ?? '') === 'entitlement';
        } catch (\Throwable $e) {
            return false;
        }
    }

    /**
     * KC-PATCH：判断是否为充值套餐。
     * 任何异常都返回 false（降级放行），确保不因插件缺失而中断返利。
     */
    private function kcIsTopupPlan(int $planId): bool
    {
        if ($planId <= 0) {
            return false;
        }
        try {
            if (!\Illuminate\Support\Facades\Schema::hasColumn('v2_plan', 'kc_is_topup')) {
                return false;
            }
            return (int) \Illuminate\Support\Facades\DB::table('v2_plan')
                ->where('id', $planId)
                ->value('kc_is_topup') === 1;
        } catch (\Throwable $e) {
            return false;
        }
    }

    /**
     * KC-PATCH:ENTITLEMENT-PRICE —— 代充按「用户权益价」结算（Step 7 接线）。
     *
     * 只在**代充类**商品上生效（kc_card.category 为 recharge 或未配置）：
     *   · 权益包商品（category=entitlement）—— 买权益包本身不打折；
     *   · 充值套餐（kc_is_topup=1）         —— 余额充值不打折。
     * 折扣来自 KC 侧用户 grant（kc_entitlement_grants），由 KC 集成报价端点
     * /api/integration/entitlement/quote 按 base_cents 折算；仅当结果低于原价时改写
     * 本单 total_amount。KC 端同时把所用 grant 落进 kc_order_pricing_snapshot，
     * 供发货成功后按 trade_no 幂等扣次。
     *
     * 任何异常 / 超时 / KC 不可达一律保持原价，绝不阻断下单。
     */
    private function kcApplyEntitlementPrice(Plan $plan): void
    {
        try {
            $baseCents = (int) $this->order->total_amount;
            if ($baseCents <= 0) {
                return;
            }

            $planId = (int) $plan->id;
            if ($planId <= 0 || $this->kcIsTopupPlan($planId)) {
                return;
            }
            // 仅代充类商品：判定分类为 recharge / 未配置，其余（权益包、人工交付）不接线
            try {
                $raw = \Illuminate\Support\Facades\DB::table('v2_plan')->where('id', $planId)->value('kc_card');
                if (!empty($raw)) {
                    $card = is_string($raw) ? json_decode($raw, true) : (is_array($raw) ? $raw : null);
                    $cat = is_array($card) ? (string) ($card['category'] ?? 'recharge') : 'recharge';
                    if ($cat !== '' && $cat !== 'recharge') {
                        return;
                    }
                }
            } catch (\Throwable $e) {
                return; // 分类读不到 → 不接线（保守）
            }

            // 从插件配置读 KC 地址与集成密钥（与插件侧同源，避免内核写死）
            $baseUrl = '';
            $apiKey = '';
            try {
                $rawCfg = \Illuminate\Support\Facades\DB::table('v2_plugins')->where('code', 'kc_integration')->value('config');
                $cfg = is_string($rawCfg) ? json_decode($rawCfg, true) : (is_array($rawCfg) ? $rawCfg : []);
                if (is_array($cfg)) {
                    $baseUrl = rtrim((string) ($cfg['kc_base_url'] ?? ''), '/');
                    $apiKey = (string) ($cfg['integration_key'] ?? '');
                }
            } catch (\Throwable $e) {
                return;
            }
            if ($baseUrl === '' || $apiKey === '') {
                return;
            }

            $resp = \Illuminate\Support\Facades\Http::withHeaders([
                'X-Integration-Key' => $apiKey,
                'Accept'            => 'application/json',
            ])->timeout(3)->connectTimeout(2)->asJson()->post(
                $baseUrl . '/api/integration/entitlement/quote',
                [
                    'user_id' => (int) $this->order->user_id,
                    'items'   => [[
                        'plan_code' => 'xplan_' . $planId,
                        'base_cents' => $baseCents,
                        'qty'       => 1,
                        'trade_no'  => (string) $this->order->trade_no,
                    ]],
                ]
            );
            if ($resp->failed()) {
                return;
            }
            $json = $resp->json();
            $q = is_array($json) ? ($json['data']['quotes'][0] ?? null) : null;
            if (!is_array($q) || (string) ($q['applied_source'] ?? '') !== 'entitlement') {
                return;
            }
            $final = (int) ($q['final_cents'] ?? $baseCents);
            if ($final > 0 && $final < $baseCents) {
                $this->order->total_amount = $final;
                \Illuminate\Support\Facades\Log::channel('daily')->info('[KC-PATCH] 权益价改写订单金额', [
                    'trade_no'    => (string) $this->order->trade_no,
                    'plan_id'     => $planId,
                    'base_cents'  => $baseCents,
                    'final_cents' => $final,
                ]);
            }
        } catch (\Throwable $e) {
            // 权益价接线失败 → 原价，绝不阻断下单
        }
    }

    private function haveValidOrder(User $user): Order|null
    {
        return Order::where('user_id', $user->id)
            ->whereNotIn('status', [Order::STATUS_PENDING, Order::STATUS_CANCELLED])
            ->first();
    }

    private function getSurplusValue(User $user, Order $order)
    {
        if ($user->expired_at === NULL) {
            $lastOneTimeOrder = Order::where('user_id', $user->id)
                ->where('period', Plan::PERIOD_ONETIME)
                ->where('status', Order::STATUS_COMPLETED)
                ->orderBy('id', 'DESC')
                ->first();
            if (!$lastOneTimeOrder)
                return;
            $nowUserTraffic = Helper::transferToGB($user->transfer_enable);
            if (!$nowUserTraffic)
                return;
            $paidTotalAmount = ($lastOneTimeOrder->total_amount + $lastOneTimeOrder->balance_amount);
            if (!$paidTotalAmount)
                return;
            $trafficUnitPrice = $paidTotalAmount / $nowUserTraffic;
            $notUsedTraffic = $nowUserTraffic - Helper::transferToGB($user->u + $user->d);
            $result = $trafficUnitPrice * $notUsedTraffic;
            $order->surplus_amount = (int) ($result > 0 ? $result : 0);
            $order->surplus_order_ids = Order::where('user_id', $user->id)
                ->where('period', '!=', Plan::PERIOD_RESET_TRAFFIC)
                ->where('status', Order::STATUS_COMPLETED)
                ->pluck('id')
                ->all();
        } else {
            $orders = Order::query()
                ->where('user_id', $user->id)
                ->whereNotIn('period', [Plan::PERIOD_RESET_TRAFFIC, Plan::PERIOD_ONETIME])
                ->where('status', Order::STATUS_COMPLETED)
                ->get();

            if ($orders->isEmpty()) {
                $order->surplus_amount = 0;
                $order->surplus_order_ids = [];
                return;
            }

            $orderAmountSum = $orders->sum(fn($item) => $item->total_amount + $item->balance_amount + $item->surplus_amount - $item->surplus_credit);
            $orderMonthSum = $orders->sum(fn($item) => self::STR_TO_TIME[PlanService::getPeriodKey($item->period)] ?? 0);
            $firstOrderAt = $orders->min('created_at');
            $expiredAt = Carbon::createFromTimestamp($firstOrderAt)->addMonths($orderMonthSum);

            $now = now();
            $totalSeconds = $expiredAt->timestamp - $firstOrderAt;
            $remainSeconds = max(0, $expiredAt->timestamp - $now->timestamp);
            $cycleRatio = $totalSeconds > 0 ? $remainSeconds / $totalSeconds : 0;

            $plan = Plan::find($user->plan_id);
            $totalTraffic = $plan?->transfer_enable * $orderMonthSum;
            $usedTraffic = Helper::transferToGB($user->u + $user->d);
            $remainTraffic = max(0, $totalTraffic - $usedTraffic);
            $trafficRatio = $totalTraffic > 0 ? $remainTraffic / $totalTraffic : 0;

            $ratio = $cycleRatio;
            if (admin_setting('change_order_event_id', 0) == 1) {
                $ratio = min($cycleRatio, $trafficRatio);
            }


            $order->surplus_amount = (int) max(0, $orderAmountSum * $ratio);
            $order->surplus_order_ids = $orders->pluck('id')->all();
        }
    }

    public function paid(string $callbackNo)
    {
        try {
            [$order, $shouldDispatch] = DB::transaction(function () use ($callbackNo) {
                $order = $this->lockCurrentOrder();
                if (!$order) {
                    throw new \RuntimeException('Order not found.');
                }
                if ((int) $order->status !== Order::STATUS_PENDING) {
                    return [$order, false];
                }

                $order->status = Order::STATUS_PROCESSING;
                $order->paid_at = time();
                $order->callback_no = $callbackNo;
                if (!$order->save()) {
                    throw new \RuntimeException('Failed to save order status.');
                }

                return [$order, true];
            });

            $this->order = $order;

            if ($shouldDispatch) {
                OrderHandleJob::dispatchSync($order->trade_no);
            }
        } catch (\Exception $e) {
            Log::error($e);
            return false;
        }
        return true;
    }

    public function cancel(): bool
    {
        try {
            $cancelledOrder = DB::transaction(function () {
                $order = $this->lockCurrentOrderWhenStatus(Order::STATUS_PENDING);
                if (!$order) {
                    return null;
                }

                HookManager::call('order.cancel.before', $order);

                $order->status = Order::STATUS_CANCELLED;
                if (!$order->save()) {
                    throw new \RuntimeException('Failed to save order status.');
                }
                if ($order->balance_amount) {
                    $userService = new UserService();
                    if (!$userService->addBalance($order->user_id, $order->balance_amount)) {
                        throw new \RuntimeException('Failed to add balance.');
                    }
                }

                return $order;
            });

            if (!$cancelledOrder) {
                return false;
            }

            $this->order = $cancelledOrder;
            HookManager::call('order.cancel.after', $cancelledOrder);
            return true;
        } catch (\Exception $e) {
            Log::error($e);
            return false;
        }
    }

    private function setSpeedLimit($speedLimit)
    {
        $this->user->speed_limit = $speedLimit;
    }

    private function setDeviceLimit($deviceLimit)
    {
        $this->user->device_limit = $deviceLimit;
    }

    private function buyByPeriod(Order $order, Plan $plan)
    {
        // change plan process
        if ((int) $order->type === Order::TYPE_UPGRADE) {
            $this->user->expired_at = time();
        }
        $this->user->transfer_enable = $plan->transfer_enable * 1073741824;
        // 从一次性转换到循环或者新购的时候，重置流量
        if ($this->user->expired_at === NULL || $order->type === Order::TYPE_NEW_PURCHASE)
            app(TrafficResetService::class)->performReset($this->user, TrafficResetLog::SOURCE_ORDER);
        $this->user->plan_id = $plan->id;
        $this->user->group_id = $plan->group_id;
        $this->user->expired_at = $this->getTime($order->period, $this->user->expired_at);
    }

    private function buyByOneTime(Plan $plan)
    {
        app(TrafficResetService::class)->performReset($this->user, TrafficResetLog::SOURCE_ORDER);
        $this->user->transfer_enable = $plan->transfer_enable * 1073741824;
        $this->user->plan_id = $plan->id;
        $this->user->group_id = $plan->group_id;
        $this->user->expired_at = NULL;
    }

    /**
     * 计算套餐到期时间
     * @param string $periodKey
     * @param int $timestamp
     * @return int
     * @throws ApiException
     */
    private function getTime(string $periodKey, ?int $timestamp = null): int
    {
        $timestamp = $timestamp < time() ? time() : $timestamp;
        $periodKey = PlanService::getPeriodKey($periodKey);

        if (isset(self::STR_TO_TIME[$periodKey])) {
            $months = self::STR_TO_TIME[$periodKey];
            return Carbon::createFromTimestamp($timestamp)->addMonths($months)->timestamp;
        }

        throw new ApiException('无效的套餐周期');
    }

    private function openEvent($eventId)
    {
        switch ((int) $eventId) {
            case 0:
                break;
            case 1:
                app(TrafficResetService::class)->performReset($this->user, TrafficResetLog::SOURCE_ORDER);
                break;
        }
    }

    protected function applyCoupon(string $couponCode): void
    {
        $couponService = new CouponService($couponCode);
        if (!$couponService->use($this->order)) {
            throw new ApiException(__('Coupon failed'));
        }
        $this->order->coupon_id = $couponService->getId();
    }

    /**
     * Summary of handleUserBalance
     * @param User $user
     * @param UserService $userService
     * @return void
     */
    protected function handleUserBalance(User $user, UserService $userService): void
    {
        $remainingBalance = $user->balance - $this->order->total_amount;

        if ($remainingBalance >= 0) {
            if (!$userService->addBalance($this->order->user_id, -$this->order->total_amount)) {
                throw new ApiException(__('Insufficient balance'));
            }
            $this->order->balance_amount = $this->order->total_amount;
            $this->order->total_amount = 0;
        } else {
            if (!$userService->addBalance($this->order->user_id, -$user->balance)) {
                throw new ApiException(__('Insufficient balance'));
            }
            $this->order->balance_amount = $user->balance;
            $this->order->total_amount = $this->order->total_amount - $user->balance;
        }
    }
}
