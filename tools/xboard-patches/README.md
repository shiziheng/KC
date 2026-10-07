# Xboard 容器内补丁清单（容器重建后必须重打！）

容器内改动**不进镜像**，`docker compose up -d --build` 或重建 xboard 容器后会全部丢失。重建后按本文档重打。

## 补丁 1：PlanService::validatePlanAvailability —— kc_is_topup 豁免 show 校验

- **文件**：容器内 `/www/app/Services/PlanService.php`
- **原因**：充值套餐 `show=0`（FIX-1 隐藏自商品页）后，`validatePlanAvailability` 的 `!show && !renew` 分支会以「该订阅已售罄」拒绝面板建单。
- **补丁内容**：方法体开头插入：
  ```php
  // KC 补丁：充值套餐 show=0 仅隐藏自商品页，面板按 plan_id 建单需放行
  if ($this->plan->kc_is_topup) {
      return;
  }
  ```
- **重打**：`docker cp tools/xboard-patch-planservice.php xboard:/www/xboard-patch.php && docker exec xboard php /www/xboard-patch.php && docker exec xboard php artisan octane:reload`（脚本自带备份与幂等检查）

## 补丁 2：TopupController::prepare —— show=0 套餐可复用 + 新建默认隐藏

- **文件**：容器内 `/www/plugins/KcIntegration/Controllers/TopupController.php`
- **原因**：prepare 复用 SQL 带 `AND p.show = 1`，FIX-1 后永不复用、每次打开面板都生成新的 show=1 脏套餐（曾增殖出 id=12「余额充值 ¥50」）；新建分支 `'show' => 1` 同理。
- **补丁内容**：
  1. 复用 SQL 的 `AND p.show = 1` → `/* KC-PATCH2: show 不限 */`
  2. 新建分支 `'show' => 1` → `'show' => 0, // KC-PATCH2: 默认隐藏自商品页`
- **重打**：`docker cp tools/xboard-patch-topup-ctrl.php xboard:/www/xboard-patch2.php && docker exec xboard php /www/xboard-patch2.php && docker exec xboard php artisan octane:reload`

## 补丁 3：OrderService::setInvite —— 充值套餐返佣比例【后台可配置】

- **文件**：容器内 `/www/app/Services/OrderService.php`
- **原因**：**业务决策「充值不产生佣金」在代码里从未落地**。充值订单走的是普通下单流程，
  佣金照算照发 —— 实测发现两笔充值订单已实际产生并发放了佣金（合计 1500 分）。
  这会与「平台鼓励充值」的目标冲突（用户一充值，返利链路就被放大）。
- **补丁内容**：`setInvite()` 里 `if (!$isCommission) return;` 之后插入：
  ```php
  if ($this->kcIsTopupPlan((int) $order->plan_id)) {
      return;
  }
  ```
  并新增私有方法 `kcIsTopupPlan()`（查 `v2_plan.kc_is_topup`，**任何异常返回 false 降级放行**）。
- **验证**：对照实验 —— 普通套餐佣金 150、充值套餐佣金 0。
- **重打**：`docker cp tools/xboard-patches/OrderService.php xboard:/www/app/Services/OrderService.php && docker exec xboard php artisan octane:reload`
- **备份**：容器内 `/www/app/Services/OrderService.php.bak-kc`

## 补丁 4：CheckCommission::autoCheck —— 返利以「货交付」为前提

- **文件**：容器内 `/www/app/Console/Commands/CheckCommission.php`
- **原因**：原逻辑只看「订单已完成 + 满 3 天」，但订单在**发凭证（CDK）那一刻**就已标记完成 ——
  货还没真正开通。结果：**代充全部失败的订单照样发返利**（平台没赚到钱却要付佣金）。
- **补丁内容**：`autoCheck()` 的查询链上加一个 `whereExists` 子查询，
  要求该订单的卡密 `kc_status = 'completed'`；新增 `kcHasCardTable()`
  （表不存在时**降级放行**，不中断原有返利逻辑）。
  ```php
  if ($this->kcHasCardTable()) {
      $query->whereExists(function ($q) {
          $q->select(DB::raw(1))->from('v2_plugin_kc_cards')
            ->whereColumn('v2_plugin_kc_cards.trade_no', 'v2_order.trade_no')
            ->where('v2_plugin_kc_cards.kc_status', 'completed');
      });
  }
  ```
- **验证**：对照实验 —— 卡密 `completed` 的订单被结算（commission_status=2），
  卡密 `failed` 的订单被跳过（保持 0）。
- **重打**：`docker cp tools/xboard-patches/CheckCommission.php xboard:/www/app/Console/Commands/CheckCommission.php && docker exec xboard php artisan octane:reload`
- **备份**：容器内 `/www/app/Console/Commands/CheckCommission.php.bak-kc`

> ⚠️ 这两条补丁是**业务决策的落地**，不是临时修复。若将来重建容器，
> 直接复制 `tools/xboard-patches/` 下的成品文件覆盖即可（无需再改代码）。


## 新增配置：充值套餐返佣比例（后台可配）

- **位置**：Xboard 后台 → 插件 → 「KC 代充集成」→ **充值套餐返佣比例(%)**
  （配置项定义在 `plugins/KcIntegration/config.json`，后台插件页自动渲染，**无需改后台前端**）
- **默认值**：`0` = 充值不返佣（业务决策：避免与「鼓励充值」的定位冲突）
- **想放开时**：把该值改成 10（或其他比例）即可，**无需改任何代码**
- **作用范围**：**只影响充值套餐**；普通商品套餐仍按系统分销设置执行
- **读取优先级**（`OrderService::kcTopupCommissionRate()`）：
  1. 插件配置 `v2_plugins.config.topup_commission_rate`（后台插件页）
  2. `v2_settings.kc_topup_commission_rate`（备用，可用脚本设置）
  3. `0`（默认）
- **验证过的行为**：配置=0 → 充值佣金 0；配置=10 → 充值佣金 150（订单额 1500 分）
- **成品文件**：`tools/xboard-patches/plugin-config.json`（直接覆盖容器内 `plugins/KcIntegration/config.json`）
## 宿主侧备份

- `tools/xboard-patches/PlanService.orig.php` —— 补丁 1 打前的原文件
- `tools/xboard-patches/KcIntegration/` —— 补丁 2 打前的整个插件目录
- 容器内另有 `/www/PlanService.php.orig.bak`、`/www/TopupController.php.orig.bak`

## 补丁 5：FEAT-018 S4 代充失败补偿台账

- **目录**：`KcIntegration/database/migrations/2026_10_06_000000_create_kc_compensations_table.php`、`Models/KcCompensation.php`、`Services/CompensationService.php`、`Controllers/CompensationController.php`
- **作用**：纯余额支付失败自动退回一次；外部支付进入 `manual_pending`；混合支付只退余额部分，外部部分保留人工退款状态；所有补偿以 `trade_no`/`idempotency_key` 唯一约束和行锁保证幂等。
- **状态触发**：`StatusController` 和兑卡轮询明确拿到 KC `failed` 时创建补偿；KC 不可达、排队或未知状态不自动退款。
- **接口**：用户 `GET /user/kc/compensations`；管理员 `GET /admin/kc/compensations`、`POST /recheck`、`POST /retry`、`POST /mark-manual-done`。
- **部署**：`docker exec xboard php artisan migrate --path=plugins/KcIntegration/database/migrations --force`，然后 `docker exec xboard php artisan octane:reload`。
- **安全边界**：用户响应只返回通用“代充未完成”和补偿状态，不返回供应商原始错误或 Session；外部支付没有确认退款 API 前，不能把人工队列标记为已退款。

## 补丁 6：FEAT-018 S5 统一履约状态

- **目录**：`KcIntegration/Models/KcCard.php`、`KcIntegration/Controllers/CardController.php`、`KcIntegration/Controllers/StatusController.php`、`KcIntegration/Controllers/RedeemController.php`
- **作用**：固化 `pending/validating/running/completed/failed/compensating/manual` 七态；状态代理和公开兑卡状态返回统一字段，KC 不可达保留缓存并标记 `stale`；支付订单状态不再推导代充成功。
- **部署**：容器重建后覆盖上述三个插件文件，然后执行 `docker exec xboard php artisan octane:reload`。S5 不新增迁移。
- **安全边界**：状态消息使用通用文案，不回传供应商原始错误或 Session；MOCK 安全锁必须保持开启。

## 补丁 7：FEAT-018 S6 账务流水与余额复算

- **目录**：`KcIntegration/database/migrations/2026_10_06_010000_create_kc_ledger_table.php`、`Models/KcLedger.php`、`Services/LedgerService.php`、`Controllers/LedgerController.php`，以及 `Plugin.php`、`TopupService.php`、`CompensationService.php`、`routes/api.php` 的对应改动。
- **作用**：以 `event_key` 唯一键记录充值到账、订单余额扣款、失败补偿三类流水；用户可只读查询，管理员可按用户/订单/类型查询并复算余额差异。
- **部署**：覆盖插件源文件后执行 `docker exec xboard php artisan migrate --path=plugins/KcIntegration/database/migrations --force`，再执行 `docker exec xboard php artisan octane:reload`。
- **安全边界**：不回填历史假流水，不提供前台调账接口；分销佣金仍不纳入本段；MOCK 安全锁保持开启。

## 相关数据修复（一次性，重建容器不影响 DB 无需重做）

- `v2_plan`：所有 `kc_is_topup=1` 套餐 `show=0`；id=2 改名「余额充值 ¥100」
- 执行脚本：`tools/xboard-fix1-hide-topup-plans.php`（幂等）

## 验收

- 断言脚本：`tools/_fix13_verify.js`（11 项断言，2026-09-26 全绿）
- 证据截图：`docs/验收/shots/fix3_blocked.png`、`fix4_amount.png`
