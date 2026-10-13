<?php

namespace Plugin\KcIntegration;

use App\Exceptions\ApiException;
use App\Models\Order;
use App\Services\Plugin\AbstractPlugin;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Plugin\KcIntegration\Models\KcCard;
use Plugin\KcIntegration\Services\CompensationService;
use Plugin\KcIntegration\Services\LedgerService;
use Plugin\KcIntegration\Services\TopupService;
use Plugin\KcIntegration\Support\SupplierHealthClient;

/**
 * KC 代充集成插件
 *
 * 钩子布局（FEAT-004 · D2 起）：
 *   1. payment.notify.verified —— 支付回调验签后、履约分派前的**充值订单主路径**：
 *      加余额 + 直接置 COMPLETED，使 PaymentController::handle() 的
 *      `status !== PENDING → return true` 短路成立，从而完全跳过
 *      paid()/OrderHandleJob/open()，原生激活（会覆写用户订阅）不会发生。
 *   2. order.open.after —— Xboard 订单履约完成后向 KC 申领 ChatGPT 代充卡密，
 *      落库 v2_plugin_kc_cards 供前台订单页展示；充值订单在此处只做兜底加钱。
 *
 * ⚠️ 三条铁律（违反会中断 Xboard 订单履约，务必保持）：
 *   1. 除了 `onPaymentVerified` 和 S6 的 `onOrderCreated` 外，本插件回调**绝不能抛异常**。
 *      OrderHandleJob 的 $tries=3，普通履约回调抛异常会触发重试并可能让订单进入异常状态，
 *      所有普通逻辑包在 try/catch(\Throwable) 里。`onPaymentVerified` 异常必须上抛让支付渠道重试；
 *      `onOrderCreated` 位于余额扣款的核心 DB 事务中，流水写失败必须上抛以回滚订单与余额。
 *   2. HTTP 超时必须短。OrderHandleJob 的 $timeout=5 秒，且 order.open.after 就在该
 *      job 内执行。默认 3 秒，连接超时 2 秒。
 *   3. KC 失败不能影响订单。订单此时已 STATUS_COMPLETED 且事务已提交，插件只做
 *      「记录结果」，不做任何回滚。
 */
class Plugin extends AbstractPlugin
{
    /** KC 支持的档位名，与 KC 侧 GPT_API_PLAN_MAP 的 value 对齐 */
    protected const VALID_PLAN_TYPES = ['plus', 'pro_5x', 'pro_20x'];

    /** 默认 HTTP 超时（秒），受 config 的 http_timeout 覆盖 */
    protected const DEFAULT_TIMEOUT = 3;

    /** 连接超时（秒），恒小于总超时 */
    protected const CONNECT_TIMEOUT = 2;

    public function boot(): void
    {
        // priority 20 = HookManager 默认优先级，订单履约完成后第一时间执行
        $this->listen('order.open.after', [$this, 'onOrderOpened'], 20);

        // ── FEAT-004 · D2：充值订单主路径拦截 ──
        $this->listen('payment.notify.verified', [$this, 'onPaymentVerified'], 20);

        // ── FEAT-004 · D2：充值套餐下单约束（防折抵套利）──
        $this->listen('order.create.before', [$this, 'onOrderCreateBefore'], 20);

        // S6：订单创建时核心已完成余额抵扣；在同一事务内写入扣款流水。
        $this->listen('order.create.after', [$this, 'onOrderCreated'], 20);
    }

    /**
     * 充值套餐下单约束（FEAT-004 · D2）。
     *
     * 钩子位置：OrderService::createFromRequest() 里 validatePurchase 之后、
     * DB::transaction 之前。此处抛 ApiException 会直接传到 save 接口给用户看，
     * 且没有事务副作用。
     *
     * 为什么必须拦：setOrderType() 会把「有未过期订阅的用户买另一个套餐」判定为
     * TYPE_UPGRADE，并把旧订阅剩余价值折抵（getSurplusValue）进本订单；而充值
     * 履约是「按套餐配置的固定金额加余额」且不覆写订阅 —— 若不拦，用户可用旧
     * 订阅剩余价值低价「换」全额余额，且旧订阅还在，等于双花。
     */
    public function onOrderCreateBefore($payload): void
    {
        try {
            if (!is_array($payload) || count($payload) < 3) {
                return;
            }
            [$user, $plan, $period] = $payload;
            if (!$plan instanceof \App\Models\Plan || !$user instanceof \App\Models\User) {
                return;
            }

            $service = new TopupService();
            if (!$service->isTopupPlan((int) $plan->id)) {
                // S8：代充商品在支付前必须通过 KC 的已持久化健康摘要。
                // 没有套餐映射的普通 Xboard 商品不在本插件范围内；人工交付分类也放行。
                $manualCat = $this->manualDeliveryCategory((int) $plan->id);
                $planType = $this->resolvePlanType((int) $plan->id);
                if ($manualCat === null && $planType !== null) {
                    $deliveryState = $this->configuredDeliveryState((int) $plan->id);
                    if ($deliveryState === 'soon') {
                        throw new ApiException('当前商品暂未开放自动办理，请稍后重试或联系客服');
                    }
                    if ($deliveryState === 'soldout') {
                        throw new ApiException('当前商品暂不可售，请稍后重试或联系客服');
                    }
                    if ($deliveryState === 'manual') {
                        throw new ApiException('当前商品需要人工确认，请联系客服办理');
                    }
                    $healthClient = new SupplierHealthClient(
                        (string) $this->getConfig('kc_base_url', ''),
                        (string) $this->getConfig('integration_key', ''),
                        2,
                        1
                    );
                    if (!$healthClient->sellableFor($planType)) {
                        throw new ApiException('当前代充服务暂不可售，请稍后重试或联系客服');
                    }
                }
                return;
            }

            // 1) 只允许一次性付费：prices 只配置了 onetime 档。
            //    ⚠️ 此时 $period 是 FormRequest 验证后的**原始入参**（旧版键），
            //    OrderSave 白名单是 onetime_price；getPeriodKey 在后面事务里才转 'onetime'。
            //    两种键都接受（防绕过 FormRequest 直调新版键），其余一律拒绝 ——
            //    否则会算出 0 元单或按错误档位金额下单。
            $p = (string) $period;
            if ($p !== 'onetime' && $p !== 'onetime_price') {
                throw new ApiException('余额充值套餐仅支持一次性支付');
            }

            // 2) 已有有效订阅（或永久订阅）的用户禁止购买，防 upgrade 折抵套利
            if ($user->plan_id !== null && ($user->expired_at === null || (int) $user->expired_at > time())) {
                throw new ApiException('您当前有有效订阅，暂不支持同时充值余额');
            }

            // 3) 禁用优惠券：避免「实付金额 ≠ 到账金额」的口径混乱
            if (!empty($payload[3])) {
                throw new ApiException('余额充值不支持使用优惠券');
            }
        } catch (ApiException $e) {
            throw $e; // 业务拦截必须向上抛，save 接口会展示给用户
        } catch (\Throwable $e) {
            // 非业务异常吞掉：不能因为插件自身故障阻断所有下单
            Log::channel('daily')->error('[KcIntegration] order.create.before 异常: ' . $e->getMessage());
        }
    }

    /**
     * 记录订单创建阶段已经发生的余额扣款。
     *
     * Xboard 把余额当作下单时的抵扣额，真正的扣款发生在核心
     * OrderService::createFromRequest() 内，而不是 pay-balance 接口。
     * 该钩子仍在核心事务中，流水写失败必须抛出，让订单和余额一起回滚，
     * 避免出现“余额已扣但无流水”的不可对账状态。
     */
    public function onOrderCreated($order): void
    {
        if (!$order instanceof Order || (int) ($order->balance_amount ?? 0) <= 0) {
            return;
        }

        (new LedgerService())->recordOrderDebit($order);
    }

    /**
     * 支付回调验签通过后的充值订单拦截（FEAT-004 · D2 主路径）。
     *
     * 钩子位置：PaymentController::notify() 内 verify 之后、handle() 之前。
     * handle() 第一步就是 `if (status !== PENDING) return true`，所以这里把
     * 充值订单直接置 COMPLETED 即可让原生履约（paid → OrderHandleJob → open →
     * buyByOneTime/buyByPeriod 覆写用户订阅）完全不发生。
     *
     * ⚠️ 异常策略（与本插件其它回调相反）：本方法内**任何异常都上抛**——
     *    notify() 的 catch 会返回 fail，支付渠道收到 fail 会重试通知；
     *    重试是安全的（TopupService 按 trade_no 幂等，不会重复加钱）。
     *    绝不能吞异常：吞掉后订单会静默落入原生履约流程，充值套餐会覆写用户订阅。
     */
    public function onPaymentVerified($verify): void
    {
        $tradeNo = is_array($verify) ? (string) ($verify['trade_no'] ?? '') : '';
        if ($tradeNo === '') {
            return;
        }

        try {
            $order = Order::where('trade_no', $tradeNo)->first();
            if (!$order instanceof Order) {
                return; // 订单不存在，handle() 会自行报 400202，不干预
            }

            $service = new TopupService();
            if (!$service->isTopupPlan((int) $order->plan_id)) {
                return; // 普通订阅订单，走原生履约
            }

            // ── 以下为充值订单主路径 ──
            $amount = $service->resolveAmount((int) $order->plan_id);
            $result = $service->apply($tradeNo, (int) $order->user_id, $amount);

            if (!$result['ok']) {
                throw new \RuntimeException('充值加余额失败: ' . $result['error']);
            }

            // 置 COMPLETED（覆盖两种情形）：
            //   首次回调：PENDING → COMPLETED，handle() 读到非 PENDING 直接短路
            //   渠道重放：已是 COMPLETED，无需再动（幂等由 topups.trade_no UNIQUE 保证）
            $fresh = Order::where('trade_no', $tradeNo)->first();
            if ($fresh && (int) $fresh->status === Order::STATUS_PENDING) {
                $fresh->status      = Order::STATUS_COMPLETED;
                $fresh->paid_at     = time();
                $fresh->callback_no = (string) ($verify['callback_no'] ?? '');
                if (!$fresh->save()) {
                    throw new \RuntimeException('充值订单状态落库失败');
                }
            }

            Log::channel('daily')->info('[KcIntegration] 充值订单已拦截履约（主路径）', [
                'trade_no' => $tradeNo,
                'amount'   => $result['amount'],
                'skipped'  => $result['skipped'],
            ]);
        } catch (\Throwable $e) {
            Log::channel('daily')->error('[KcIntegration] 充值订单拦截异常: ' . $e->getMessage(), [
                'trade_no' => $tradeNo,
            ]);
            throw $e; // 上抛 → notify() 返回 fail → 渠道重试（幂等安全）
        }
    }

    /**
     * 订单履约完成后的发卡入口。
     *
     * 该方法的任何分支都不得向外抛异常。
     */
    public function onOrderOpened($order): void
    {
        $tradeNo = 'unknown';

        try {
            if (!$order instanceof Order) {
                return;
            }

            $tradeNo = (string) $order->trade_no;

            if (!$this->getConfig('enabled', true)) {
                return;
            }

            // ── FEAT-004 · D2：充值套餐走「加余额」分支，不走发卡
            //    必须是本方法里**第一顺位**的判断：充值套餐不该申领卡密。
            if ($this->handleTopup($order, $tradeNo)) {
                return;
            }

            // 幂等前置检查：已有成功记录则跳过，避免任务重试导致重复申领
            $existing = KcCard::where('trade_no', $tradeNo)->first();
            if ($existing && $existing->isIssued()) {
                return;
            }

            $userRef = $this->resolveUserRef($order);

            // ── FEAT-009：非代充类商品（成品号 / 建站服务等）走人工交付，不自动发卡
            //    判断依据是套餐的卡片配置分类（kc_card.category），非 recharge 即人工交付。
            $manualCat = $this->manualDeliveryCategory((int) $order->plan_id);
            if ($manualCat !== null) {
                $this->record($tradeNo, $order, '', KcCard::STATUS_SKIPPED, '人工交付（分类：' . $manualCat . '），未自动发卡', $userRef);
                Log::channel('daily')->info('[KcIntegration] 人工交付订单，跳过自动发卡', [
                    'trade_no' => $tradeNo,
                    'category' => $manualCat,
                ]);
                return;
            }

            $planType = $this->resolvePlanType((int) $order->plan_id);
            if ($planType === null) {
                $this->record($tradeNo, $order, '', KcCard::STATUS_SKIPPED, '未配置套餐映射(plan_id=' . (int) $order->plan_id . ')', $userRef);
                return;
            }

            $result = $this->callKcIssue($tradeNo, $planType, $userRef);

            if ($result['ok']) {
                $this->record($tradeNo, $order, $planType, KcCard::STATUS_ISSUED, '', $userRef, $result['cdk']);
                Log::channel('daily')->info('[KcIntegration] 卡密发放成功', [
                    'trade_no'  => $tradeNo,
                    'plan_type' => $planType,
                ]);
                // v1.19.0 · R5 自动发权益：调 KC 集成端点按 plan_code 触发 grant
                // 失败仅日志，不阻塞主路径（订单已成功）
                $this->callKcEntitlementIssueAfterCdk($tradeNo, (int) $order->user_id, (int) $order->plan_id, $result['cdk']);
                return;
            }

            $this->record($tradeNo, $order, $planType, KcCard::STATUS_FAILED, $result['error'], $userRef);
            (new CompensationService())->handleTerminalFailure($order, 'cdk_issue_failed', '代充卡密发放失败');
            Log::channel('daily')->warning('[KcIntegration] 卡密发放失败', [
                'trade_no'  => $tradeNo,
                'plan_type' => $planType,
                'error'     => $result['error'],
            ]);
        } catch (\Throwable $e) {
            // 兜底：无论如何都不能让异常逃逸到 Xboard 的订单履约链路
            Log::channel('daily')->error('[KcIntegration] 发卡回调异常: ' . $e->getMessage(), [
                'trade_no' => $tradeNo,
                'trace'    => $e->getTraceAsString(),
            ]);

            try {
                $this->record($tradeNo, null, '', KcCard::STATUS_FAILED, '插件内部异常: ' . $e->getMessage());
                if ($order instanceof Order) {
                    (new CompensationService())->handleTerminalFailure($order, 'plugin_internal_failed', '代充履约插件异常');
                }
            } catch (\Throwable $ignored) {
                // 连记录都失败时静默 —— 已经无路可退，不能影响履约
            }
        }
    }

    // ------------------------------------------------------------------
    // 内部实现
    // ------------------------------------------------------------------

    /**
     * 充值套餐处理（FEAT-004 · D2）。
     *
     * 返回 true 表示「这笔订单是充值订单，已由本方法处理完毕」，
     * 调用方应立即 return，**不得**再走发卡逻辑。
     *
     * ⚠️ 本方法同样不得抛异常（同 onOrderOpened 的铁律）。
     */
    protected function handleTopup(Order $order, string $tradeNo): bool
    {
        try {
            $planId = (int) $order->plan_id;

            $service = new TopupService();

            if (!$service->isTopupPlan($planId)) {
                return false; // 普通套餐，交给后续发卡逻辑
            }

            $amount = $service->resolveAmount($planId);
            $userId = (int) $order->user_id;

            $result = $service->apply($tradeNo, $userId, $amount);

            if ($result['ok']) {
                Log::channel('daily')->info('[KcIntegration] 充值套餐处理完成', [
                    'trade_no' => $tradeNo,
                    'amount'   => $result['amount'],
                    'skipped'  => $result['skipped'],
                ]);
            } else {
                Log::channel('daily')->warning('[KcIntegration] 充值套餐处理失败', [
                    'trade_no' => $tradeNo,
                    'error'    => $result['error'],
                ]);
                (new CompensationService())->handleTerminalFailure($order, 'topup_credit_failed', '余额充值到账失败');
            }

            return true;
        } catch (\Throwable $e) {
            // 兜底：充值失败也绝不能影响订单履约
            Log::channel('daily')->error('[KcIntegration] 充值分支异常: ' . $e->getMessage(), [
                'trade_no' => $tradeNo,
                'trace'    => $e->getTraceAsString(),
            ]);

            return true; // 已识别为充值套餐，不再走发卡
        }
    }

    /**
     * 把 Xboard 的 plan_id 映射为 KC 档位名。
     * 未配置或配置了非法档位时返回 null（调用方记为 skipped）。
     */
    /**
     * FEAT-009：返回该套餐的人工交付分类名；null 表示自动交付（代充）。
     * 异常一律按自动交付处理，绝不影响既有发卡流程。
     */
    protected function manualDeliveryCategory(int $planId): ?string
    {
        try {
            $raw = DB::table('v2_plan')->where('id', $planId)->value('kc_card');
            if (empty($raw)) { return null; }
            $card = json_decode((string) $raw, true);
            if (!is_array($card)) { return null; }
            $cat = isset($card['category']) ? (string) $card['category'] : 'recharge';
            if ($cat === '' || $cat === 'recharge') { return null; }
            return $cat;
        } catch (\Throwable $e) {
            return null;
        }
    }

    /** 读取商品卡片的自动履约状态；读取异常按在售兼容，健康检查仍会继续兜底。 */
    protected function configuredDeliveryState(int $planId): string
    {
        try {
            $raw = DB::table('v2_plan')->where('id', $planId)->value('kc_card');
            $card = is_string($raw) ? json_decode($raw, true) : null;
            $state = is_array($card) ? (string) ($card['state'] ?? 'onsale') : 'onsale';
            return in_array($state, ['soon', 'soldout', 'manual'], true) ? $state : 'onsale';
        } catch (\Throwable $e) {
            return 'onsale';
        }
    }

    protected function resolvePlanType(int $planId): ?string
    {
        $packages = $this->getConfig('packages', []);
        if (is_string($packages)) {
            $packages = json_decode($packages, true) ?: [];
        }
        if (!is_array($packages)) {
            return null;
        }

        $planType = $packages[(string) $planId] ?? $packages[$planId] ?? null;
        if (!is_string($planType) || $planType === '') {
            return null;
        }

        return in_array($planType, self::VALID_PLAN_TYPES, true) ? $planType : null;
    }

    /**
     * 用户标识：优先邮箱（可读，便于 KC 后台排查），退化到用户ID。
     */
    protected function resolveUserRef(Order $order): string
    {
        try {
            $email = $order->user?->email;
            if (is_string($email) && $email !== '') {
                return $email;
            }
        } catch (\Throwable $ignored) {
        }

        return 'xboard:' . (int) $order->user_id;
    }

    /**
     * 调用 KC 的发卡接口。
     *
     * @return array{ok: bool, cdk: string, error: string}
     */
    protected function callKcIssue(string $tradeNo, string $planType, string $userRef): array
    {
        $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
        $apiKey  = (string) $this->getConfig('integration_key', '');

        if ($baseUrl === '' || $apiKey === '') {
            return ['ok' => false, 'cdk' => '', 'error' => 'KC 地址或集成密钥未配置'];
        }

        $timeout = (int) $this->getConfig('http_timeout', self::DEFAULT_TIMEOUT);
        if ($timeout < 1 || $timeout > 5) {
            $timeout = self::DEFAULT_TIMEOUT;
        }

        try {
            $response = Http::withHeaders([
                'X-Integration-Key' => $apiKey,
                'Accept'            => 'application/json',
            ])
                ->timeout($timeout)
                ->connectTimeout(self::CONNECT_TIMEOUT)
                ->asJson()
                ->post($baseUrl . '/api/integration/cdk/issue', [
                    'ref'       => $tradeNo,
                    'plan_type' => $planType,
                    'source'    => 'xboard',
                    'user_ref'  => $userRef,
                ]);
        } catch (\Throwable $e) {
            return ['ok' => false, 'cdk' => '', 'error' => '请求 KC 失败: ' . $e->getMessage()];
        }

        if ($response->failed()) {
            return [
                'ok'    => false,
                'cdk'   => '',
                'error' => 'KC 返回 HTTP ' . $response->status() . ': ' . mb_substr((string) $response->body(), 0, 300),
            ];
        }

        $json = $response->json();
        if (!is_array($json)) {
            return ['ok' => false, 'cdk' => '', 'error' => 'KC 返回非 JSON 内容'];
        }

        // KC 集成接口约定（实测 server.js:3997）：成功为 success:true，
        // 卡密在 data.cdk，错误信息在 message（不是 code/msg，勿凭直觉改写）
        if (($json['success'] ?? false) !== true) {
            $msg = (string) ($json['message'] ?? '未知错误');
            return ['ok' => false, 'cdk' => '', 'error' => 'KC 业务失败: ' . mb_substr($msg, 0, 300)];
        }

        $data = $json['data'] ?? [];
        $cdk  = (string) ($data['cdk'] ?? '');

        if ($cdk === '') {
            return ['ok' => false, 'cdk' => '', 'error' => 'KC 成功响应中缺少卡密字段(data.cdk)'];
        }

        return ['ok' => true, 'cdk' => $cdk, 'error' => ''];
    }

    /**
     * v1.19.0 · R5 自动发权益（失败仅日志，不阻塞主路径）
     * 入参：tradeNo, userId, planId, cdk
     * 行为：调 KC POST /api/integration/entitlement/issue-after-cdk
     */
    protected function callKcEntitlementIssueAfterCdk(string $tradeNo, int $userId, int $planId, string $cdk): void
    {
        try {
            $baseUrl = rtrim((string) $this->getConfig('kc_base_url', ''), '/');
            $apiKey  = (string) $this->getConfig('integration_key', '');
            if ($baseUrl === '' || $apiKey === '') {
                return;
            }
            $timeout = (int) $this->getConfig('http_timeout', self::DEFAULT_TIMEOUT);
            if ($timeout < 1 || $timeout > 5) {
                $timeout = self::DEFAULT_TIMEOUT;
            }
            // plan_code 约定：xplan_<v2_plan.id>（与 R2 回填脚本一致）
            $planCode = 'xplan_' . $planId;
            $payload = [
                'user_id'   => $userId,
                'plan_code' => $planCode,
                'trade_no'  => $tradeNo,
                'cdk'       => $cdk,
            ];
            $response = Http::timeout($timeout)
                ->withHeaders([
                    'X-Integration-Key' => $apiKey,
                    'Accept'            => 'application/json',
                ])
                ->post($baseUrl . '/api/integration/entitlement/issue-after-cdk', $payload);
            Log::channel('daily')->info('[KcIntegration] 自动发权益回调', [
                'trade_no' => $tradeNo,
                'plan_code' => $planCode,
                'status'   => $response->status(),
                'body'     => mb_substr((string) $response->body(), 0, 300),
            ]);
        } catch (\Throwable $e) {
            // 不上抛：发卡已成功，自动发权益失败仅记录
            Log::channel('daily')->warning('[KcIntegration] 自动发权益回调异常: ' . $e->getMessage(), [
                'trade_no' => $tradeNo,
            ]);
        }
    }

    /**
     * 写入/更新发卡记录。trade_no 唯一，重复触发时累加 attempts。
     */
    protected function record(
        string $tradeNo,
        ?Order $order,
        string $planType,
        string $status,
        string $errorMsg = '',
        string $userRef = '',
        string $cdk = ''
    ): void {
        if ($tradeNo === '' || $tradeNo === 'unknown') {
            return;
        }

        $card = KcCard::firstOrNew(['trade_no' => $tradeNo]);

        if ($order instanceof Order) {
            $card->plan_id = (int) $order->plan_id;
        }

        // user_ref 列为 NOT NULL：无论是新建还是已有记录，都必须兜底为非 null 字符串
        $resolvedRef = $userRef !== '' ? $userRef : (string) $card->user_ref;
        $card->user_ref = $resolvedRef !== '' ? $resolvedRef : '-';

        if ($planType !== '') {
            $card->plan_type = $planType;
        }
        if ($cdk !== '') {
            $card->cdk_code = $cdk;
        }

        $card->status    = $status;
        $card->error_msg = mb_substr($errorMsg, 0, 500);
        $card->attempts  = (int) $card->attempts + 1;

        $card->save();
    }
}
