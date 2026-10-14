<?php

use Illuminate\Support\Facades\Route;
use Plugin\KcIntegration\Controllers\CardController;
use Plugin\KcIntegration\Controllers\RedeemController;
use Plugin\KcIntegration\Controllers\StatusController;
use Plugin\KcIntegration\Controllers\TopupController;
use Plugin\KcIntegration\Controllers\PlanCardController;
use Plugin\KcIntegration\Controllers\AfterSalesController;
use Plugin\KcIntegration\Controllers\OrderPayController;
use Plugin\KcIntegration\Controllers\CompensationController;
use Plugin\KcIntegration\Controllers\EntitlementController;
use Plugin\KcIntegration\Controllers\LedgerController;
use Plugin\KcIntegration\Controllers\RiskController;
use Plugin\KcIntegration\Controllers\AdminMenuController;
use Plugin\KcIntegration\Controllers\SupportController;

/*
|--------------------------------------------------------------------------
| KC 集成插件 API 路由
|--------------------------------------------------------------------------
|
| 由 PluginManager::loadRoutes() 以 api 中间件组 + 命名空间
| Plugin\KcIntegration\Controllers 自动载入。
|
| ⚠️ 重要：插件路由**没有** /api 前缀。
|   PluginManager::loadRoutes() 只挂了 middleware('api')，并未加 prefix。
|   因此本文件中的 prefix('user/kc') 对应的真实访问路径是：
|
|       /user/kc/card      （不是 /api/user/kc/card）
|       /user/kc/cards
|       /user/kc/status
|
|   这是实测结论（php artisan route:list 可见），照抄 Xboard 文档写 /api 会 404。
|
| 另一条注意：插件路由不会自动带用户鉴权，必须显式声明 'user' 中间件
|   （别名 'user' = App\Http\Middleware\User，校验 Sanctum 登录态）。
|
| 部署注意：容器为 Octane/Swoole 常驻进程，新增路由后需执行
|   php artisan octane:reload  否则 HTTP 侧不生效（CLI 侧立即可见）。
|
*/

Route::prefix('user/kc')->middleware('user')->group(function () {
    // 查询当前登录用户名下某订单的卡密
    Route::get('/card', [CardController::class, 'query']);
    // 查询当前登录用户的全部卡密列表
    Route::get('/cards', [CardController::class, 'list']);
    // 查询某订单的 KC 侧开通状态（服务端代理，绕开 KC 无 CORS 的限制）
    Route::get('/status', [StatusController::class, 'status']);
    // 权益包：查询当前登录用户的生效权益（服务端代理 KC 集成接口）
    Route::get('/entitlements', [EntitlementController::class, 'mine']);
    // ── FEAT-004 · D3：充值 ──
    // 把金额落成一次性充值套餐，返回 plan_id（前台随后走原生 save→checkout）
    Route::post('/topup/prepare', [TopupController::class, 'prepare'])->middleware('throttle:10,1');
    // 按订单号查充值记录（订单页展示「已充值 $X 到余额」；全站金额一律美元计价）
    Route::get('/topup/info', [TopupController::class, 'info']);
    // FEAT-014：充值订单台账（按 pending/overdue/done/failed 分组）
    Route::get('/topup/orders', [TopupController::class, 'orders'])->middleware('throttle:30,1');
    // FEAT-018 S4：用户查看代充失败补偿状态（只返回脱敏状态）
    Route::get('/compensations', [CompensationController::class, 'mine']);
    // FEAT-018 S6：用户只读余额流水与复算结果
    Route::get('/ledger', [LedgerController::class, 'mine']);
    // FEAT-018 S9：用户订单售后申请、补充说明和取消
    Route::get('/after-sales', [AfterSalesController::class, 'mine']);
    Route::post('/after-sales', [AfterSalesController::class, 'create'])->middleware('throttle:10,1');
    Route::get('/after-sales/{requestNo}', [AfterSalesController::class, 'detail']);
    Route::post('/after-sales/{requestNo}/message', [AfterSalesController::class, 'message'])->middleware('throttle:20,1');
    Route::post('/after-sales/{requestNo}/cancel', [AfterSalesController::class, 'cancel']);
});

/*
|--------------------------------------------------------------------------
| 前台兑卡（FEAT-004 · D1）—— 刻意「不需要登录」
|--------------------------------------------------------------------------
|
| CDK 本身就是凭证：兑出来的订阅打在**用户自己粘贴的 ChatGPT 账号**上，
| 因此「谁去兑」不改变「商品归谁」。这是本组路由不挂 'user' 中间件的原因。
|
| 因为是公开接口，必须有限流（throttle）与 Origin 校验（控制器内）。
|   限流档位：verify 5/分、start 3/分、status 120/分（状态要轮询，给宽些）
|
| 真实访问路径（同样无 /api 前缀）：
|     POST /kc/redeem/verify
|     POST /kc/redeem/start
|     GET  /kc/redeem/status
|
*/
Route::prefix('kc/redeem')->group(function () {
    Route::post('/verify', [RedeemController::class, 'verify'])->middleware('throttle:5,1');
    Route::post('/start', [RedeemController::class, 'start'])->middleware('throttle:3,1');
    Route::get('/status', [RedeemController::class, 'status'])->middleware('throttle:120,1');
});

// FEAT-018 S4：管理员补偿队列。Xboard 仍使用独立管理员会话，KC 不代理密码。
Route::prefix('admin/kc/compensations')->middleware(['user', 'admin'])->group(function () {
    Route::get('/', [CompensationController::class, 'adminList']);
    Route::post('/recheck', [CompensationController::class, 'recheck']);
    Route::post('/retry', [CompensationController::class, 'retry']);
    Route::post('/mark-manual-done', [CompensationController::class, 'markManualDone']);
});

// FEAT-018 S6：管理员只读流水与用户余额复算，不提供任意调账接口。
Route::prefix('admin/kc/ledger')->middleware(['user', 'admin'])->group(function () {
    Route::get('/', [LedgerController::class, 'adminList']);
    Route::get('/reconcile', [LedgerController::class, 'reconcile']);
});

// FEAT-018 S7：风险事件只读查询、阈值配置和临时拦截解除。
Route::prefix('admin/kc/risk')->middleware(['user', 'admin'])->group(function () {
    Route::get('/', [RiskController::class, 'index']);
    Route::post('/rules', [RiskController::class, 'updateRules']);
    Route::post('/release', [RiskController::class, 'release']);
});

// FEAT-018 S9：管理员售后处理；退款动作只进入 S4 CompensationService。
Route::prefix('admin/kc/after-sales')->middleware(['user', 'admin'])->group(function () {
    Route::get('/', [AfterSalesController::class, 'adminList']);
    Route::get('/{requestNo}', [AfterSalesController::class, 'adminDetail']);
    Route::post('/{requestNo}/process', [AfterSalesController::class, 'process']);
});

// USDT 充值异常与余额补单：只允许 Xboard 管理员使用，KC 不代管 Xboard 密码。
Route::prefix('admin/kc/topups')->middleware(['user', 'admin'])->group(function () {
    Route::get('/', [TopupController::class, 'adminList']);
    Route::post('/credit', [TopupController::class, 'adminCredit']);
    Route::post('/mark-review', [TopupController::class, 'adminMarkReview']);
});

// 客服工作台（SP-2026-10-11 · P1）：只读聚合查询（用户全景 / 订单进度 + KC 实时复核）。
// 页面载体：/plugins/kc_integration/support（routes/web.php）。
Route::prefix('admin/kc/support')->middleware(['user', 'admin'])->group(function () {
    Route::get('/user', [SupportController::class, 'user']);
    Route::get('/order', [SupportController::class, 'order']);
});

// Xboard 非代充菜单清理策略（只读，可供统一入口或管理端壳读取）。
Route::get('/admin/kc/menu-policy', [AdminMenuController::class, 'index'])->middleware(['user', 'admin']);

// FEAT-006：商品卡片配置（公开 · 免登录，供前台商品页读取卡片展示内容）
Route::get('/plan/kc-cards', [PlanCardController::class, 'index']);

// FEAT-010：余额结算（余额已全额抵扣的订单 → 推进履约与发卡）
Route::prefix('kc/order')->middleware('user')->group(function () {
    Route::post('/pay-balance', [OrderPayController::class, 'payBalance']);
});
