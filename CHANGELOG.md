# CHANGELOG · KC-PAY-GPT

> **本文件是版本记录的唯一正本，只追加、不覆写。**
> **最新版本永远在最顶部 —— 读第一个条目即可，不需要搜索。**
> 配套规范见 `docs/开发规范.md`；入口见 `README.md` 顶部「开发协作入口」。

格式：`v主版本.次版本.修订号 · 日期 · 一句话标题`
新增功能升次版本，修 bug 升修订号，架构重写升主版本。

---

## v1.34.0 · 2026-10-15 · 代充按「用户权益价」结算（接线：展示层 + 结算层 + 扣次）

**一句话概括**：把「买权益包 → 之后的代充更便宜」从**只有展示层**接成**端到端真结算** —— 前台 `#/plan` 商品卡改为展示**当前登录用户真实的权益价**（有权益 6 折 `$9.00`，无权益只显原价 `$15.00`）、Xboard 下单前按用户报价**改写订单金额**、履约成功**扣次**、失败/退款**退次**。全程**无新表、无新体系**（KC 新增 2 个集成端点 + 插件 1 个报价代理 + 内核 1 处价格改写锚点）。

### 新增

- **KC 集成端点（`server.js`，`X-Integration-Key` 鉴权）**：
  - `POST /api/integration/entitlement/quote`：按 `user_id + items[{plan_code,base_cents}]` 返回权益报价；当带 `trade_no` 且确有权益时落报价快照 `kc_order_pricing_snapshot`（供后续扣次反查）。
  - `POST /api/integration/entitlement/consume`：按 `order_trade_no` 幂等扣次；未传 `grant_id` 时回读快照反查。
  - 新增 helper `entitlementActiveGrants(user_id)` / `bestGrantFor(grants, baseCents, planCode, now)`（跳过过期/次数用尽/未达门槛/不在 `plan_scope`；按 `percent`/`fixed_cents`/`fixed_price_cents` 取最低价）。
- **插件用户态报价代理**：`KcIntegration/Controllers/QuoteController.php` + 路由 `POST /user/kc/quotes`（`user` 中间件 + `throttle:60,1`）。`user_id` **一律取自登录态**（不接受前端传入，杜绝越权）；只回报价数值，KC 不可达时降级为「原价」（`{quotes:[],stale:true}`）。
- **履约扣次/退次**：`Plugin::onOrderOpened()` 交付成功分支调 `callKcEntitlementConsume($tradeNo)`，`cdk_issue_failed` / `plugin_internal_failed` 分支调 `callKcEntitlementRefund($tradeNo)`（均只传 `order_trade_no`、超时 3s、不抛异常）。
- 验收脚本 `tools/_v134_settle_verify.js`（**20 项断言**）。

### 变更

- **Xboard 内核补丁 +1（P8，`tools/xboard-patch-check.js` 核查项 8 → 9）**：`OrderService::kcApplyEntitlementPrice()`（锚点 `ENTITLEMENT-PRICE`）—— 在 `createFromRequest()` 内 `applyCoupon` 之前，对**代充类**商品（`kc_card.category=recharge`/未配置 且非充值套餐）带 `trade_no` 调 KC 报价；报价 `final < base` 时改写 `$this->order->total_amount`；**任何异常静默保持原价**。
- **KC `POST /api/integration/entitlement/refund` 改造**：现支持**仅传 `order_trade_no`**（自动按 `kc_entitlement_uses` 反查 grant 退次），`grant_id` 变可选。
- **前台 `tools/kc_plan_double_price.html` 数据源改造**：不再读全局 `site-config.plans[].quotaPrice`，改为 `POST /user/kc/quotes`；**仅当** `applied_source==='entitlement'` 且 `final_cents < base_cents` 才显示双价（无权益/未登录/KC 不可达 → 保留主题原价，不改造），避免「人人看到 $12 却按 $15 付」的展示层失真。

### 验证

- `node tools/_v134_settle_verify.js` **20/20 全绿**（截图 `logs/v134-settle/2026-10-15T01-29-31-090Z/`）：
  - **F1 展示层**：有权益用户 `#/plan` 展示真实权益价 `$9.00` / 原价划线 `$15.00` / 「用 1 次权益 · 省 $6.00」。
  - **F2 结算层（铁证）**：有权益下单 → `v2_order` 应付合计 `total_amount+balance_amount+surplus_amount` = **900 分 = $9.00**（非原价 1500）；取消后余额恢复。
  - **F3 扣次幂等**：KC `quote→consume→consume→refund` 使 grant `5 → 4 → 4 → 5`。
  - **F4 无权益**：耗尽 grant → 页面双价标注 `0` 个 → 应付 = 1500 分（原价）→ 恢复。
  - **U1** 深色下 `.kcdp-num` 恒 `rgb(0,168,98)`、原价划线可辨；**U2** 窄屏 480px 零横向溢出；**U3** 句式统一 + 零禁词。运行期 JS 错误 `[]`。
- 首轮 F2/F4 因断言口径误判（Xboard 余额足额抵扣时 `total_amount=0`，抵扣额记入 `balance_amount`）一度 17/20，改为断言「三项之和」后复跑 **20/20**。
- 测试后状态已复原（`balance=20000`、`grant=5`、测试订单已取消、测试快照/流水已删）。
- `node tools/xboard-patch-check.js` 全部 **9/9** 补丁在位。

### 影响与风险

- **未改项（既有设计差异，非本步缺陷）**：首页门户 `#kc-home-portal` 仍按 `marketPrice` 口径显示 `quotaPrice=$12.00`（省 $8.00），而 `#/plan` 现按**我方原价**口径显示 `$9.00`（省 $6.00）—— 两者基准不同，已登记为「整体验收 + 首页门户口径确认」待办（`docs/改版进度.md`「二 / Step 8」）。
- **部署与回滚**：KC 改动 `docker restart kc-gpt-pay2-app`；插件/内核 `docker cp` + `octane:reload`（内核重建会丢，用 `tools/xboard-patch-check.js --fix` 重打）；前台 `node tools/xboard-apply-custom-html.js`（custom_html 378657 → 380131 字符）。回滚见 `docs/改版进度.md`「四 / Step 7 / 如何回滚」。

### 下一步

- **整体验收 + 首页门户口径确认（可选）**：请用户对 Step 0-7 全链路做整体走查，并确认首页门户是否要与 `#/plan` 的权益价口径统一（若统一，首页块需改为读用户真实报价）。
- 其余（非本版本范围）：移动端 ≤480px 首屏排布打磨、深色模式手动开关。
- 明细见 `docs/改版进度.md`「二、下一步 / Step 8」与「四 / Step 7」。

---

## v1.33.0 · 2026-10-14 · 权益包独立页 `#/pack`（≠ 代充 · 不进代充流程 · 买后不覆写订阅）

**一句话概括**：把「权益包」从代充商品页里**彻底拆出来**、做成**独立页 `#/pack`** —— 导航定型为 **代充 / 成品号 / 建站服务 / 权益包 / 我的订单**（5 项）；买权益包只走「余额扣减 → KC 发权益（N 次按权益价下单的机会）」这一条链，**不进入代充开通向导、不粘贴 Session、不发卡密**，也**不覆写用户已有订阅**。同时**作废 v1.32.0 里「原代充改名权益包→`#/plan`」的口径**（该口径违反「权益包 ≠ 代充」产品铁律）。

### 新增

- **权益包独立页 `#/pack`**（`tools/kc_theme_inject.html` 注入块内新增「A2. 权益包独立页」段）：Hero（方案说明 + 与代充的关系）+ 商品卡（配置驱动，来自后台录入的权益包商品）+ 「我的权益」（余额 + 已开通权益剩余次数/有效期）+ FAQ + 「用余额开通」按钮。`#/pack` 用 `pushState` + `sessionStorage.kc_pack_intent` 意图记忆接管（**即使 Vue 把 hash 重写成 `#/404` 仍展示本页**）。
- **导航新增「权益包」入口**：顶栏 `HTML_TOPBAR` 与移动端抽屉 `HTML_DRAWER` **两处同步**新增 `<a href="#/pack" data-route="#/pack" data-pack="1">权益包</a>`；`syncActive()` 新增 `data-pack` 分支（读 `sessionStorage` 意图，遵守跨块铁律）。
- **后台可录的权益包商品**：`v2_plan` 新增 2 档（`id=21 轻享权益包` $60.00 / 5 次、`id=22 尊享权益包` $600.00 / 50 次；`show=0`、`sell=1`、`kc_card.category='entitlement'`）；插件 `PlanCardController::index()` 新增 `packs` 字段，前台**零硬编码**（种子脚本 `tools/xboard-pack-seed.php`）。
- **权益规则**（KC `kc_entitlement_rules`）：`pack_light_off40 ← xplan_21`（5 次）、`pack_pro_off40 ← xplan_22`（50 次），`percent 40`（6 折）、`plan_scope=[]`（全商品适用）、`grant_period_days=180`（种子脚本 `tools/kc-seed-entitlement-rules.js`）。
- **KC 集成端点**：`GET /api/integration/entitlement/grants?user_id=`（`X-Integration-Key` 鉴权，JOIN 规则返回剩余次数/有效期/折扣）。
- **插件用户态代理**：`EntitlementController::mine()` + 路由 `GET /user/kc/entitlements`（服务端代理 KC，绕开 KC 无 CORS / 无用户态鉴权）。
- 验收脚本 `tools/_v133_pack_verify.js`（**27 项断言**）+ 验收辅助 `tools/_v133_user.php`。

### 变更

- **导航定型 5 项**（置代 v1.32.0 的 4 项口径）：`代充`（保留，→ `#/plan`）/ `成品号` / `建站服务` / `权益包`（**新增，→ `#/pack`**）/ `我的订单`。首项文案回正为「代充」（`data-cat="recharge"`）；`setupNavCategories()` 的文案回写仍保持删除。
- **Xboard 内核补丁 +2**（`tools/xboard-patch-check.js` 核查项 6 → 8）：
  - **P1b `PlanService`**：权益包商品（`kc_card.category='entitlement'`）豁免 `show` 校验（锚点 `kc_entitlement_pack`，幂等）；
  - **P7 `OrderService::open()`**：权益包商品**短路开通** —— 直接置 `Order::STATUS_COMPLETED` 返回，**不写用户订阅、不覆写 `plan_id`/`expired_at`**（锚点 `ENTITLEMENT-PACK`）。
- **插件 `Plugin::onOrderOpened()`**：新增 `category='entitlement'` 分支（调 KC 发权益；失败走 `CompensationService`），**不进人工交付/不发卡**；`callKcEntitlementIssueAfterCdk()` 由 `void` 改为返回 `array{ok,error}`。
- **前端渲染竞态修复**：`renderPack()` 引入渲染序号 `packSeq`（并发重绘只认最新一次）；成功提示 `packFlashMsg` 改为**粘性**（跨重绘保留，离开页面或发起下一次开通才清）——修「开通成功提示被静态文案覆盖」。

### 验证

- `node tools/_v133_pack_verify.js` **27/27 全绿**（截图 `logs/v133-pack/2026-10-14T16-31-25-872Z/`）：导航 5 项与三页一致、`#/pack` 接管与直访意图识别、商品两档价格/次数、我的权益空态与余额行、**权益包≠代充机检**（页内零「Session / 卡密」）、余额开通端到端（下单 → 余额抵扣 → 履约发权益 → 「剩余 5 次」）、深色可读（亮度 187.7）、主色恒 `rgb(0,168,98)`、窄屏零横向溢出、运行期 JS 错误 `[]`。
- **买权益包不覆写订阅（实测铁证）**：购买 `轻享权益包`（订单 `plan_id=21`）后，`v2_user` 的 `plan_id=1`、`expired_at=1804213647` **未变**。
- **结算口径实测**：`v2_order` 订单 `balance_amount=468` + `surplus_amount=5532` = **6000 分 = $60.00**（价格正确；Xboard 采用「旧订单剩余价值折抵优先、余额补差」，故「用余额开通」按钮下**余额扣减额可小于包价**）。
- 首轮 21/27 → 暴露并修复 3 类问题（顶栏高亮未同步、结算路径 404、并发重绘冲掉提示）后复跑全绿。
- `node tools/xboard-patch-check.js` 全部 **8/8** 补丁在位。

### 影响与风险

- **未接线项（已登记为 Step 7）**：`#/plan` 双价卡上的 `quotaPrice` 是 `site-config` 的**全局配置**，与「当前用户有没有权益」无关；**Xboard 下单金额仍取自 `v2_plan.prices`，结算层尚未按用户 grant 折算** ⇒ 当前「买权益包 → 代充更便宜」**只有展示层**。代价最小接线方案见 `docs/改版进度.md`「二 / Step 7」。
- **回滚**：删 `HTML_TOPBAR`/`HTML_DRAWER` 的 `data-pack` 项 + 删 Block B「A2」整段后重新部署（`node tools/xboard-apply-custom-html.js`）；商品侧将 `v2_plan` id 21/22 的 `show` 改回 0，并按 `tools/xboard-patch-check.js` 撤 P1b/P7。

### 下一步

- **Step 7 · 接线「代充按用户权益价结算」**（本版本已登记的关键缺口）：`#/plan` 双价卡的 `quotaPrice` 是 `site-config` 全局配置，结算层未按用户 grant 折算。
  - 代价最小方案：插件新增用户态报价路由 `POST /kc/order/quote`（代理 KC 的权益折扣引擎 `/api/pricing/quote` 语义）→ Xboard 下单前按报价改写 `total_amount` → 交付成功后调 KC 扣次（`order_trade_no` 幂等；失败/退款走已有 `POST /api/integration/entitlement/refund` 退次）。
  - 验收口径：有权益用户下单金额 = 权益价 / 无权益用户 = 原价 / 下单失败或退款退次。
  - 明细见 `docs/改版进度.md`「二、下一步 / Step 7」与 `docs/方案/前台改版MVP方案-v1.0.0.md`「Step 7」。

---

## v1.32.0 · 2026-10-14 · 前台改版（KC 直供）Step 1-5：全局配色 + 首页门户双价 + 商品页双价 + 导航收敛 + 收尾

**一句话概括**：把 `design/前台改版demo-v2.1.0.html` 落地到线上商城（**注入式改版，不改主题块内核**）——统一墨黑 + 省钱绿配色、首页把价格前置并可直观看到「权益价 vs 市场价」、商品页承接同款双价、顶栏导航收敛 5→4 并把「权益包」做成主入口，最后完成术语与深色收口。本版本同时把 v1.28.2（后台 UX 流）与 v1.29~v1.31（前台改版流）**合并登记为同一版本号 v1.32.0**。

### 新增

- `tools/kc_home_portal.html`（**Step 2 首页门户**，自带 `style`+`script` 单块自洽，约 30KB）：压制旧 dashboard 门户（`body.kc-home-v2 #kc-portal{display:none}`，容器用 `<section>` 天然豁免主题压制规则）+ 注入新门户：价格前置 Hero（权益价大字 + 市场行情对照 + 解锁条件）→ 门槛对比（左灰「先充值数千美元起」/ 右绿权益价）→ 三步 → 商品双价卡 → 权益包三档（轻享 / 畅享 / 建站）。全量数据来自 `GET /api/public/site-config`，**代码零硬编码价格**；600ms 守护 + `hashchange` 抵住 Vue 重建；仅 dashboard 生效。
- `tools/kc_plan_double_price.html`（**Step 3 商品页 #/plan 双价**，自带 `style`+`script`，约 9.6KB）：压制主题单价格行 `.kc-cb-price`（加 `.kcdp-has` 类 + `display:none`）并在原位置插入独立标注层 `.kcdp-box`（权益价 32px 省钱绿 + 「官方直充」角标搬运 + 「用 1 次权益 · 省 $X」+ 原价划线）；权益价来自 `site-config.plans[].quotaPrice`、原价沿用主题写入卡的 `data-kc-price-fen`（与首页**同一算法**）；**仅 `#/plan` 列表页生效**（正则排除详情页），离开即 `clear()`。
- 验收脚本：`tools/_v132_home_verify.js`（13 项）、`tools/_v132_plan_verify.js`（14 项）、`tools/_v132_nav_verify.js`（20 项）、`tools/_v132_final_verify.js`（10 项）（`tools/_*.js` 为本地验收脚本，被 .gitignore 忽略）。
- 进度单一事实源：`docs/改版进度.md`（含全部决策/关键坐标/已知坑/每步测试用例/下一步）。

### 变更

- **Step 1 全局配色**（`tools/kc_theme_inject.html` 设计 token）：品牌强调色 teal `#0d9488` → **墨黑 + 省钱绿 `#00A862`**；hover `#00915A`；soft `rgba(0,168,98,.10)`（深色 `.18`）；渐变 `#14b8a6→#34D399`、阴影/文字色同步换绿，**旧青绿残留 0**。
- **Step 4 导航收敛 5→4**（`tools/kc_theme_inject.html`）：顶栏 `HTML_TOPBAR .kc-tb-nav` 与移动端抽屉 `HTML_DRAWER .kc-drawer-nav` **两处同步**去掉冗余「首页」（改由左上 logo 承担回首页），原「代充」项改名 **「权益包」**（仍指向 `#/plan` 权益价/购买区）→ 结果 = **权益包 / 成品号 / 建站服务 / 我的订单**；并**删除 `setupNavCategories()` 里 `anchor.textContent = cats[0].name` 的回写**（否则「权益包」文案会被后台分类名「代充」覆盖，仅保留 `data-cat` 同步）。
  - ⚠️ **本条口径已被 v1.33.0 作废**：把「代充」改名「权益包」并指向 `#/plan`，违反「权益包 ≠ 代充」产品铁律（且会让用户在代充商品页买"权益包"从而落进代充流程）。v1.33.0 已回正为：**保留「代充 → `#/plan`」+ 新增独立「权益包 → `#/pack`」**，导航 5 项。此处仅作历史留档。
- **部署链**：`tools/xboard-set-custom-html.php` 的 `$srcs` 增加 `/www/kc_home_portal.html` 与 `/www/kc_plan_double_price.html`；`tools/xboard-apply-custom-html.js` 增加对应拷源行（custom_html 361806 → 361800 字符）。部署：`node tools/xboard-apply-custom-html.js`。

### 验证

- **每步均按用户要求产出「功能测试工程师 ≥3 条 + UX 专家 ≥3 条」测试用例并实测**（明细见 `docs/改版进度.md`「四、已完成」各 Step 段）：
  - Step 2 首页门户：`tools/_v132_home_verify.js` **13/13 全绿**（截图 `logs/v132-home/2026-10-14T14-22-07-252Z/`）。
  - Step 3 商品页双价：`tools/_v132_plan_verify.js` **14/14 全绿**（含与首页同源同值、配置驱动铁证、作用域隔离；截图 `logs/v132-plan/2026-10-14T14-43-54-499Z/`）。
  - Step 4 导航收敛：`tools/_v132_nav_verify.js` **20/20 全绿**（顶栏/抽屉 4 项、入口可达、违禁词、三页一致、≤860px 响应式；截图 `logs/v132-nav/`）。
  - Step 5 收尾：`tools/_v132_final_verify.js` **10/10 全绿**（三页术语零命中「会员/等级/升级/VIP」、权益句式统一、深色生效可读、主色不漂移；截图 `logs/v132-final/`）。
- **回归扫描**（证明 Step 1-4 无回退）：依次复跑 home 13/13 + plan 14/14 + nav 20/20 全绿。
- **配置驱动铁证**：后台改权益价 `$12 → $10 → $12`，首页与商品页价格即变即还原（同一配置源）。
- 三页运行期 JS 错误均为 `[]`；`node tools/check-docs-sync.js` 与 `node tools/check-currency.js` 通过。

### 影响与风险

- **纯注入式改版**：不重建前端、不动 Xboard 内核、不碰资金链路；全部改动落在 custom_html 注入块 + 主题 token，**可回滚**——Step 2/3 从 `$srcs` 移除对应注入块重新部署（约 2 分钟恢复主题原貌）；Step 1/4 按 `docs/改版进度.md` 各 Step「如何回滚」段复原。
- **配置驱动零硬编码**：价格/文案/品牌一律走 `site-config`，「省 $X」由前端按数字自动算；代码内无写死价格。
- **命名红线**：导航与文案禁「会员/等级/升级/VIP」，统一句式「用 1 次权益，省 $X」（Step 5 已全站巡检零命中）。
- **版本账本合并决策**：v1.28.2（后台 UX）+ v1.29~v1.31（前台改版）+ 本批统一为 **v1.32.0**，两条流合并入同一版本号，原 `docs/00_项目状态.md` 的「版本账本归属待定」项据此收口。
- **待办（非本版本范围）**：移动端 ≤480px 首屏细节、深色手动开关（现为 `detectDark()` 自动判定）、真实下单/支付全链路走查（Step 1-5 均为渲染层与配置层验收）。

### 下一步

- 前台改版客侧可选增强（需另立需求）：移动端 ≤480px 首屏排布打磨、深色模式手动开关、真实下单/支付全链路走查。
- 第三批（走查方案剩余项）：收银台 CNY 基准币文案（定价层决策，需先确认）、订单列表分页/加载更多、钱包页导出明细、售后与工单联动。
- 用户执行：$1 真实充值测试与小额真实首单（收款链路最终验收；用户已确认暂缓）。

---

## v1.28.2 · 2026-10-14 · 后台管理体验修复（19 页 UX 走查：权益弹窗 P0 + 表单/列表中文化）

**一句话概括**：按后台 19 页 UX 走查结论统一修复——权益弹窗恢复居中弹窗形态（P0）、权益表单去 cents/JSON 改 $ 与逗号分隔、状态枚举中文化、任务管理/自动化任务列布局修复、toast 移右上角、导航重分组、权益查询支持邮箱。

### 修复

- **P0 权益弹窗裸渲染**：v1.18.0 起权益页弹窗使用 `class="dialog-backdrop"/"dialog-card"`，但 admin.html 的 CSS **从未定义这两个类**，导致「新建规则/编辑/发权益」表单按文档流裸贴页面右上角（用户截图反馈）。补齐两组 CSS（fixed 遮罩 + 居中卡片，`max-width:560px` 可滚动），并支持点遮罩关闭。
- **权益表单去开发者视角**：门槛由 cents 改 **$ 输入**（内部换算美分，percent 类型除外）；折扣值按类型动态显示单位（% / $）；「适用 plan_code」由手写 JSON 数组改为**逗号分隔**；状态/来源/过滤下拉全部中文化；规则卡片的折扣金额改 `$` 展示。
- **任务管理**：状态徽章 SUCCESS/FAILED/CARD_INVALID → 成功/失败/卡号无效（解决列宽截断「SUC…」）；执行时间列 `white-space:nowrap` 防日期折行；状态列定宽。
- **自动化任务**：阶段列定宽 260px + td `min-width:240px`，阶段芯片恢复每行 2-3 个（此前被挤成一行一个、行高 3 倍）；状态列加 tooltip 说明「状态=自动化阶段执行结果，与 Checkout 是否打开相互独立」（口径对齐属数据层语义，见下一步）。
- **Toast 位置**：`.message-container` 从顶部居中移至右上角，不再遮挡页头标题。
- **导航重整**：新增「任务与日志」分组（任务管理/自动化任务/运行日志/登录日志）；「续费管理」图标 circle-x → rotate-ccw（原图标语义是「取消」）；删除 `plans` / `listing_cards` 两个 display:none 隐藏导航残留（页面与函数保留，仅去死入口）。
- **权益页头文案**：移除表名（kc_entitlement_rules 等）与 SP 编号，改运营语言。

### 新增

- `server.js`：`GET /api/admin/entitlements/user-lookup?email=`（只读，`requireSecondaryAuth` 保护）—— 邮箱 → Xboard user_id；权益页查询框支持直接输邮箱（`_entResolveUserId` 兼容邮箱/数字 ID 双格式）。

### 验证

- `tools/_v1282_ux_verify.js`：admin.html 内联脚本 `node --check` 1/1 通过；15 项改动点静态核对全 PASS；`node --check server.js` 通过。
- 浏览器实测（headless Chrome 登录 `/admin`，截图存 `.workbuddy/memory/ux_shots/v1282_*.png`）：新建权益规则弹窗居中 + 遮罩 + 全中文表单（`v1282_ent_dialog.png`）；任务管理日期单行、100% 成功进度条绿色/失败红色（`v1282_logs.png`）；自动化任务阶段芯片每行 3 个、状态徽章中文「成功」（`v1282_automation2.png`）；toast 右上角不遮标题（`v1282_toast.png`）；权益页新文案 + 邮箱查询入口 + 新导航（`v1282_entitlements2.png`）。
- 接口实测：`GET /api/admin/entitlements/user-lookup` 无 token → 401；带 token 查 `shiziheng134@gmail.com` → 200 `{"user_id":1,...}`。部署方式：`public/` 与 `server.js` 均为 compose 挂载卷，`docker restart kc-gpt-pay2-app` 生效（未重建镜像）。
- `node tools/check-docs-sync.js` 与 `node tools/check-currency.js` 通过（见下）。

### 影响与风险

- 仅前端展示层 + 一个只读查询接口；无数据结构、无内核、无资金链路改动。用户侧未动。
- 遗留（用户已决策）：**续费管理不改**（危险操作无确认、无生效列表——保持现状）。
- 商品管理无删除入口属**有意不做**：商品存 Xboard 内核表 `v2_plan`，删除需动内核，违反「只改 KC 侧」红线；重复的「余额充值 $2」数据（ID 6/7/8/9）建议用现有「隐藏」按钮处理。

### 下一步

- 自动化任务「SUCCESS vs Checkout 未打开」的口径对齐需在数据层统一语义（涉及 phase/status 判定逻辑），待产品确认后再动。
- 权益「发权益」对话框仍需数字 user_id（查询区已可邮箱定位后再填）。

---

## v1.28.1 · 2026-10-13 · 去掉「有未付款订单不能再下单」限制（用户：这个规则不合理）

- 背景：用户在商城有一笔待支付订单时，再点任何套餐下单都被拒 —— `POST /api/v1/user/order/save` 返回 400「您有未付款或开通中的订单，请稍后再试或将其取消」。用户判定该规则不合理，要求去掉。
- **根因**：`UserService::isNotCompleteOrderByUserId()`（`app/Services/UserService.php:106`）查 `Order::whereIn('status',[0,1])`（0=待支付、1=处理中），只要存在就抛 `ApiException`。下单路径上有 **2 处**调用它：`app/Services/OrderService.php:79`（下单服务）与 `app/Http/Controllers/V1/User/OrderController.php:71`（V1 用户下单接口）。
- **为什么这条规则不合理（四条证据）**：
  1. **内部口径不一致**：插件侧充值早已把同款限制移除 —— `plugins/KcIntegration/Controllers/TopupController.php` 文件头注释明确写着「旧实现带 `NOT EXISTS (status=0 的未支付订单)`… 这既是『有进行中订单就不能充值』的根因…该判断没有防超发价值」，现已改为「允许并发发起充值订单」。结果就是**充值可以并发、买套餐却不行**。
  2. **没有防超发价值**：套餐是虚拟商品、`capacity_limit=NULL` 不占库存，多笔待支付单不会造成超卖。
  3. **本身有回收机制**：待支付订单 `ORDER_TTL_SECONDS=1800`（30 分钟）自动失效，且有独立倒计时 UI 提示（v1.28.0 已上线）。
  4. **直接挡住正常行为**：换套餐买、上一单支付失败想重开、USDT 转错链想重试 —— 全被拦，等于丢单。
- **改动**：两处判断短路为 `if (false && $userService->isNotCompleteOrderByUserId(...))`（保留原表达式便于回溯），上方插入说明注释。补丁脚本 `tools/xboard-patch-allow-concurrent-orders.php`，**幂等可重复执行**。
- **有意保留**：`app/Http/Controllers/V2/Admin/OrderController.php:213`（管理员后台「替用户分配订阅」提示「该用户还有待支付的订单，无法分配」）—— 那是运营侧风控、口径不同，本次不动；如也要放开请再指示。
- ⚠️ **补丁防丢失的两个要点**：
  1. 已纳入 `tools/xboard-patch-check.js` 核查清单（**P5 = OrderService / P6 = V1 OrderController**，取 `ALLOW-CONCURRENT-ORDERS` 标记），`--fix` 可自动重打。
  2. ⭐**顺序陷阱**：P3 的重打方式是**整文件覆盖** `tools/xboard-patches/OrderService.php`，会把 P5 补丁冲掉 —— 所以 P5/P6 必须排在 P3 **之后**重打。同时已把打了 P5 之后的容器文件**回拷更新**了 `tools/xboard-patches/OrderService.php`（否则下次 `--fix` 直接把限制装回去）。
- 部署：容器内两文件均留 `.pre-concurrent.bak` 备份；`php -l` 双文件无错误；`php artisan octane:reload` 完成。
### 验证

- `tools/_v130_verify_concurrent.js`：下单前账号已存在 1 笔待支付单（`2026101315105517418271437` status=0）→ **连续下 2 单均 HTTP 200**，新单号 `2026101316100695560752664` / `2026101316100707115214796`，下单后「待支付/处理中」= 3，两单均出现在订单列表 → 取消清理 2 单，HTTP 200，最终归零。结论：**限制已去除**。
- `tools/xboard-patch-check.js`：**6/6 全部在位**（P1/P2/P3/P4/P5/P6）。
- 前台回归 `tools/_v129_batch2_verify.js` 全绿，且**反证改动生效**：造单由 400 变 200；筛选 tab「全部12 / 待支付2 / 已完成6 / 已关闭4」；**两笔待支付单的倒计时同时工作**（`["剩 29:48","已超时"]`），点「待支付」可见 2 行；钱包页、两套详情时间线、售后弹窗均正常；**运行期 JS 错误 `[]`**。
- 测试痕迹已清理：`kcbugtest` 账号待支付/处理中订单归零。
### 下一步

- 连带观察：放开后可同时存在多笔待支付单，需关注订单表增长（TTL 30 分钟自动失效回收，暂无需额外清理任务）。
- 若要把管理员「替用户分配订阅」的同款限制也放开，需单独指示（口径不同，本次未动）。
- 第三批（走查方案剩余项）不变：收银台 CNY 文案、订单分页、钱包导出、售后与工单联动。

---

## v1.28.0 · 2026-10-13 · 前台充值/钱包/订单走查第二批：钱包流水页 + 订单筛选/倒计时 + 详情时间线与售后入口（UX-9）

- 背景：产品体验深度走查方案（《前台充值钱包订单走查与优化-v1.0.0》）第二批——**把"钱和进度看不见"补上**：余额流水、订单状态筛选、待支付倒计时、订单全链路进度、售后入口。第一批（v1.27.0）已交付。
- **钱包流水页（新增 `#/wallet`）**：账户余额大卡 + 逐条「余额明细」（时间 / 类型 / 增减金额 / 变动后余额），消费红色 `-`、到账绿色 `+`、未完成中性灰；顶栏「余额」与抽屉余额均可点入。数据来自 `GET /user/kc/ledger`（真实资金流水）+ `GET /user/kc/topup/orders`（充值台账，按 `trade_no` 去重合并），当前余额取 `/api/v1/user/info`。
- **订单状态筛选 tab（`#/order`）**：全部 / 待支付 / 已完成 / 已关闭 四个胶囊 tab，各带实时计数；点击即行内过滤，空态给「该状态下暂无订单。」。不再让用户在一长串订单里靠肉眼找。
- **待支付 30 分钟倒计时**：列表「待支付」行在状态后追加 `剩 MM:SS`（秒级刷新）；超过 30 分钟显示「已超时」并置灰，同时隐藏该行的支付类入口（TTL 与后端 `ORDER_TTL_SECONDS=1800` 一致）。
- **订单详情四节点时间线**：详情页新增「订单进度」卡片——已下单 → 已支付（标注支付方式：账户余额 / USDT）→ 卡密已发放 → 已开通；节点按真实状态着色（完成绿 / 进行中橙 / 失败红），右侧带时间；数据取 `/api/v1/user/order/detail` + `/user/kc/status`。
- **详情页售后入口**：时间线卡片下方「申请售后」（弹窗可选 开通失败 / 超时未到账 / 申请退款 / 其他问题 并填写描述，提交至 `POST /user/kc/after-sales`）与「联系客服」（跳工单）。
- 实现方式：仍是**不重构建前端**的注入——`custom_html` 新增**第 4 个独立 `<script>` 块**（`tools/kc_wallet_inject.html`），自带 token 读取与全部工具函数，不依赖前 3 块（跨块调用一律 ReferenceError）。
- **关键坑（都已落为注释，后续务必照做）**：
  1. **Xboard 是 hash 路由，未知路由会被重写成 `#/404`** —— `#/wallet` 直接访问时 `location.hash` 变成 `#/404`，`isWallet()` 永远不成立，钱包页根本出不来。解法：点击入口时用 `history.pushState` 进 `#/wallet`（不触发 Vue router 故不被重写）+ 用 sessionStorage 记住「曾出现 `#/wallet`」兜底刷新/直接访问 + 跳到其它已知路由立即清除意图。
  2. **订单详情页有两套 DOM**：已发卡订单有 `#kc-activate-card`，待支付 / 已取消订单没有 —— 时间线必须两套锚点（前者插卡片后，后者挂到 `#app section.cus-scroll-y` 末尾），否则待支付单上时间线不出现。
  3. **主题 token 名字必须对齐**：真名是 `--kc-page-bg / --kc-card-bg / --kc-card-border / --kc-t1 / --kc-t2 / --kc-t3 / --kc-brand`（品牌色为青绿 `#0d9488`）；写成 `--kc-border / --kc-title` 只会走 fallback，浅色下看不出来、深色主题直接瞎。
  4. **`body.textContent` 会把 `<script>` 源码文本算进去** —— 注入块注释里出现过「代充开通」，导致断言假阳性。断言必须收窄到具体元素。
  5. ⭐**本地注入源会落后于线上，全量部署会静默回滚**：批次一/二都是直接改 DB 的 `custom_html`，而 `tools/xboard-set-custom-html.php` 全量部署读的是 `tools/kc_{activate,panel,theme}_inject.html` —— 一旦有人跑全量部署，两批修复全部丢失。已新增 `tools/_v129_sync_sources_from_db.js` **把线上内容回灌本地三份源**（带"回拼一致性校验"，拆完再拼必须与线上逐字节相同才落盘），并实测全量部署后 DB 长度不变。**今后规则：直接改 DB 的注入改动，收尾必须回灌本地源。**
  6. **批次一脚本的幂等缺陷（已修）**：「历史形态收敛」的替换结果本身是某个历史形态的前缀，重复执行会不断累积 —— 线上实测 `openTopup()` 里累积了 **3 行** `kcTopupSubHint();` 调用，而该函数已按需求删除，**每次打开充值面板都在 `renderAmountStep()` 之后抛 ReferenceError**（面板能出来所以前一轮验证没抓到）。已加防御性去重（`tools/_v129_fix_subhint_dup.js` 一次性清理 + `_v128_ux_batch1b.js` 内置无条件清理）；修后运行期 JS 错误为空。
- 工具：`tools/kc_wallet_inject.html`（第 4 块注入源）、`tools/_v129_ux_batch2.js`（幂等部署 + 语法/关键函数校验）、`tools/_v129_batch2_verify.js`（A 订单筛选与倒计时含超时分支 / B 钱包页 / C 入口 / D 待支付+已完成两套详情时间线与售后 / Z 运行期错误）、`tools/_v129_wallet_probe2.js`（钱包三场景：直接访问、点击入口、返回关闭）、`tools/_v129_sync_sources_from_db.js`（线上回灌本地源）、`tools/_v129_fix_subhint_dup.js`（悬空调用清理）、`tools/_v129_dup_scan.js`（重复注入扫描）。
### 验证

- 批次二（`tools/_v129_batch2_verify.js`，真实账号登录态）：筛选 tab 计数「全部9 / 待支付1 / 已完成6 / 已关闭2」✓；倒计时「剩 2:15」秒级刷新，模拟时间 +31 分钟后变 `kc-dead::已超时` ✓；点「待支付」可见行 1（其余隐藏）✓；钱包页 `kc-on`、余额卡「当前余额 $0.00 共 6 条记录」、6 行明细（2 条订单扣款红、1 条充值到账绿 `+$13.89`、3 条未完成中性灰无 `+` 号并带失败原因）✓；顶栏余额 `href=#/wallet` ✓；**待支付单与已完成单的详情时间线均 `exists` 且 4 节点内容正确** ✓；售后按钮与弹窗在位 ✓；**运行期 JS 错误 `[]`** ✓。
- 钱包页三场景（`tools/_v129_wallet_probe2.js`）：直接访问 `#/wallet`（hash 被重写为 `#/404`）仍渲染钱包 ✓；从首页点顶栏余额入口（hash 保持 `#/wallet`）✓；点「返回」关闭且 hash 回 `#/dashboard` ✓。
- 批次一回归（`tools/_v128_ux_verify2.js`）：档位 `$100/$300/$500`、无订阅提示、劝退弹窗 `false`、面板可开、切路由后面板 `none` ✓；显示 `0.00` 的单元格 **0** ✓；**非待支付行可见「取消」按钮 0**（新增断言：待支付行保留 1 个，属正确行为）✓；已完成单详情卡片「下一步：完成开通」为真、「代充开通」为假、「开通状态」标签在位、顶部「待完成开通」为真 ✓。
- 部署安全：`tools/_v129_sync_sources_from_db.js` 回拼校验通过（`291101` 字符拆分后逐字节复现）；回灌后**实跑一次全量部署**（`tools/xboard-apply-custom-html.js`），DB `custom_html` 长度保持 `290923` 不变，批次一/二修复未被回滚 ✓；`node tools/check-docs-sync.js` 与 `node tools/check-currency.js` 通过 ✓。
### 下一步

- 第三批（走查方案剩余项）：收银台 CNY 基准币文案（属定价层决策，需先确认）、订单列表分页/加载更多、钱包页导出明细、客服台与售后工单联动。
- 遗留：`kcbugtest` 测试账号现存 1 笔待支付订单（`2026101315105517418271437`，30 分钟自动失效）；平台规则「有未付款或开通中的订单时不能再下单」属既有设计，不是缺陷。
- 运维提醒：**任何直接改 DB `custom_html` 的注入改动，收尾必须跑 `tools/_v129_sync_sources_from_db.js --write` 回灌本地源**，否则下次全量部署会静默回滚。

---

## v1.27.0 · 2026-10-13 · 前台充值/钱包/订单走查第一批：充值恢复可达 + 订单金额/操作/语义修复（UX-8）

- 背景：产品体验深度走查（《前台充值钱包订单走查与优化-v1.0.0》，用真实账号余额 $9.44/10 笔订单实测）查出 5 个 P0；本版为**第一批（业务口径 + P0）**修复，原方案四批中的第二批起未动。
- **充值可达（P0-1）**：删除「有有效订阅的用户不能充值余额」的前置拦截——该规则导致**有订阅的客户根本打不开充值页**（收入流失），且与「余额优先支付」的下单逻辑自相矛盾；后端 `topup/prepare` 本也无此限制（仅金额边界 + 频控）。改为任何时候点「充值」都能进入选额页；有生效订阅时只多一句提示「你已有生效中的订阅；仍可充值余额备用，下单时余额自动优先抵扣。」。
- **充值档位业务化（P2-2）**：机场味大额档 `[7,14,42,70]` 收敛为 `[1,2,7,14]` + 自定义金额 $1~$500，面板与独立充值页两处同步。
- **订单金额修复（P0-3）**：余额支付订单 `total_amount=0`、真实金额在 `balance_amount`，原生列表只取 `total_amount` → **全部显示 0.00**（用户无法核对任何金额）。注入层用 fetch/XHR 响应嗅探建立 `trade_no → 金额` 缓存后回填：列表显示 `$15.00` + 「余额支付/USDT 支付」小字；详情页「订单信息」里的裸数字补 `$`。
- **订单操作按状态收紧（P0-4）**：已完成/已取消/已关闭订单隐藏「取消」按钮（页内可见「取消」按钮实测 8 → 0）。
- **详情状态单一语义（P0-5）**：区块标题「代充开通」→「下一步：完成开通」，状态徽章前加「开通状态」标签；顶部原生说明「订单已支付并开通。」按真实开通状态联动改写（待开通 → 「订单已支付，卡密已发放，待完成开通。」）。
- **浮层随路由关闭（P0-2）**：切页自动关闭充值面板 / 充值页 / 抽屉 / 兑卡浮层。
- **余额口径统一（P2-1）**：充值面板与充值页统一为「充值到账即成为账户余额：下单时余额优先抵扣，不足可直接用 USDT 支付。」。
- 关键坑（已落为注释）：`custom_html` 由 **3 个独立 `<script>`（各自 IIFE）** 组成，**跨块按函数名调用一律 ReferenceError**——浮层关闭只能走 DOM；订单增强挂载点在块#3、被调函数在块#2，靠 `window.*` 暴露打通。另一坑：**改 `custom_html` 后必须 `php artisan cache:clear`**，否则前台仍返回旧 HTML（本次因此白跑一轮验证）。
- 工具：`tools/_v128_ux_batch1b.js`（**基线重建 + 全量关键函数校验 + 语法校验 + 幂等**；检测到 `openPanel` 等关键函数缺失时自动从 `logs/_custom_html_backup.html` 重建——上一版脚本的"清理错位注入块"曾误删 3213 字符）、`tools/_v128_ux_verify2.js`（充值可达/档位/自定义金额/金额回填/取消收紧/浮层关闭）、`tools/_v128_detail_check.js`（详情语义与金额断言）。
### 验证

- 登录态真实账号实测（全部通过）：充值面板可打开且标题为「余额充值 · 选择金额」、档位 `$1/$2/$7/$14`、自定义输入在位、劝退弹窗 `false`、订阅提示一句话 ✓；切路由后面板 `none`（浮层关闭生效）✓；订单列表 8 行「0.00」单元格 **4 → 0**、页内可见「取消」按钮 **8 → 0** ✓；详情页副标题已变为「订单已支付，卡密已发放，待完成开通。」、旧文案 `false`、订单信息行「余额支付 **$15.00**」✓；`node tools/check-docs-sync.js` 闸门通过。
### 下一步

- 第二批（对应走查方案 v1.28.0）：钱包流水页（`#/wallet`，充值/消费逐条含变动后余额）、订单状态筛选 tab（全部/待支付带角标/已完成/已关闭）、待支付 30 分钟自动关闭 + 倒计时 + 恢复支付、详情页四节点时间线（下单→支付→发卡→开通）、详情页售后入口（直达工单预填订单号）；待支付订单的「继续支付/取消」维持原生未改。

---

## v1.26.0 · 2026-10-13 · API 客户自助门户：凭证/文档/订单/余额自助 + 运营总开关（UX-7）

- 背景：用户要求"前端研发一个 API 菜单、后端可控开关、开放给接接口的客户"——按《API 客户自助门户设计 v1.0.0》（SP-2026-10-13-PORTAL-v1.0.0）实施，方案即执行口径。
- **独立门户 `/api-portal`**（`public/api-portal.html`，原生 SPA）：客户用 **API Key + Secret 登录**（portal token = HMAC 自签、24h、`PORTAL_TOKEN_SECRET` 入 .env；**client_id 仅来自 token，禁客户端传参**）；登录失败统一"凭证不正确"、同 IP 10 次/分钟限流。
- **五页菜单**（侧栏导航）：**概览**（余额大卡 / 今日·本月报价与订单四宫格 / 接入三步清单）/ **API 凭证**（Base URL、API Key 明文可复制、Secret 掩码 + 重置（旧值立即失效、新值一次性展示）、签名规则速查 + curl/Node/Python 三语言示例）/ **接入文档**（快速开始、4 接口参数与响应示例、签名详解、错误码表、锁价/幂等/限流规则）/ **我的订单**（下游单号/金额/状态/卡密可复制，仅本客户）/ **余额与消费**（余额 + 流水，`recharge/consume/refund` 三型）。
- **运营总开关**（你要求的后端可控）：后台「API 客户」页顶部「客户自助门户」Switch → `app_config.api_portal_enabled`；**关闭后门户登录 403「维护中」，但下游程序里的 API 调用完全不受影响**（急停按钮只停人不停程序）。
- **余额流水闭环**（对账是门户立身之本）：新增 `kc_api_balance_ledger` 表；充值（recharge）/ 下单扣费（consume）/ 履约失败退回（refund）三处自动记流水；门户「余额与消费」页展示。
- **信息红线**（方案 §3.2 落实）：门户**不暴露**成本价/加价率/上游身份/其他客户/运营功能——客户只看"自己付多少、买了什么、怎么调用"。
- 管理接口：`GET/POST /api/admin/api-portal/setting`（开关）；门户接口 `/api/portal/{login,me,credentials,orders,billing,credentials/reset-secret}`。
- 验证（双轨全绿）：
  - API 层 `tools/_v126_verify.js` 16 项：登录 200 / 错 secret 401 / me 200（余额+统计+GMV）/ credentials（Key 明文、Secret 不返回）/ orders 2 笔含卡密 / **billing consume 流水 2 条** / 无 token 401 / **重置 Secret 后旧 secret 登录 401、旧 secret 调 API 401、新 secret 200** / **开关关闭→登录 403 PORTAL_DISABLED、恢复→200** / 门户静态页 200 ✓
  - UI 层 `tools/_v126_verify_ui.js` 12 项：登录页 → 门户五页全渲染（凭证页 Key 明文+掩码+HMAC 示例、文档 3903 字）→ 后台开关 UI（on）→ **toggle 关闭后 app_config=0 + UI 状态同步** → 恢复=1 → **充值 $500→$600 + ledger recharge 流水 1 条** ✓
- 踩坑修复（同款解构 bug 三处）：`const [x] = await store.runQuery()` 取到的是**行对象**，不能再 `x[0]`——me/billing/C2/C3/C1 五处已修并全量扫描无同类残留；门户 JS 单引号嵌单引号致语法错一处已修；curl 示例 URL 拼重一处已修。
- 部署：server.js + mysql-store.js + admin.html + public/api-portal.html（挂载，容器重启）；测试客户/订单/流水残留已清理（当前 0 客户）。
- 上线前置（开放给真实客户前）：域名 + HTTPS 反代（门户上公网、密钥登录必须 TLS）；建议先 1 个内测客户灰度。
- 下一步（后续版本）：客户级加价覆盖、交付回调 webhook、成本自动同步、报价日志后台可视化。

### v1.25.1 · 2026-10-13 · 修复：收银台把美元订单当人民币折算（$15 → 2.24 USDT）

- 背景：用户实测「购买卡密」发现平台显示 $15/月，跳转 BEpusdt 收银台却显示「15 CNY · 2.24 USDT」——平台少收款约 6.7 倍。
- **根因**（证据链）：Xboard EPay 插件 `pay()` 把订单美分 ÷100 得 `money=15.00` 发给 BEpusdt `/submit.php`，但**未传 fiat 参数**；BEpusdt 易支付兼容接口（`app/handler/epay/epay.go` `verify()`）在缺失 fiat 时**默认按 `model.CNY` 解读**，15 元人民币 ÷6.69 汇率 = 2.24 USDT。bep_order 落库佐证：`fiat=CNY, rate=6.69, money=15, amount=2.24`（10-12 起共 4 笔同型订单）。
- **修复**：`tools/xboard-patches/Epay/Plugin.php`（成品，已打容器 + 重建重打用）—— `$params` 增加 `'fiat' => 'USD'`，金额数值不变。BEpusdt 侧 `epay.go` 本就支持 `fiat` 参数（`model.Fiat(fiat)`，USD 汇率自动同步自 coingecko），无需改 BEpusdt。签名无需适配：fiat 参与双方同一套「非空参数字典序 k=v& + key」MD5 计算。
- 影响面：**所有走 EPay 渠道的订单**（购买卡密 + 余额充值，含充值尾数识别逻辑）全部修正为美元 1:1 口径；Xboard 回调侧只按 `trade_no` 记账、不采信收银台金额，无连带影响。
- 资损说明：修复前用户若按收银台金额实付 2.24 USDT，BEpusdt 回调验签通过后 Xboard 即按 $15 订单履约（发货/到账）——属资损漏洞，本次随修复关闭；历史 4 笔低额订单未造成实际损失（测试单/未付单），已留档 order_id。
- 部署：容器内 `/www/plugins-core/Epay/Plugin.php` 覆盖 + `php artisan octane:reload` + `php -l` 通过；容器内备份 `Plugin.php.pre-fiatusd.bak`；仓库成品 `tools/xboard-patches/Epay/Plugin.php` + `.orig` 原件。
- 验证：`tools/_v1251_fiat_usd_verify.js`（与修复后插件 pay() 同构的 epay 请求，含签名）——POST /submit.php → 302 收银台；DB 核对 `fiat=USD, money=15, amount=15.02, rate=0.999126`（1:1；修复前同单 2.24）；收银台 200；测试单已清理（只删本脚本建的 order_id，未动历史数据）。
- 下一步：① 用户在商城真实走一笔「购买卡密」到收银台页确认显示「15 USD · ≈15 USDT」（不支付，过期自动关闭）；② 考虑把该核查并入 `tools/xboard-patch-check.js`（容器重建后自动核查 fiat=USD 在位）。

### 验证

- 接口层：`tools/_v1251_fiat_usd_verify.js` 全绿（fiat=USD / money=15 / amount=15.02 / 302 / 收银台 200 / 测试单清理 1 行）。
- 语法与运行时：`php -l` 无错误；`php artisan octane:reload` 成功。
- 回归：bep_wallet 前置（恰好 1 个启用 usdt.trc20）满足；BEpusdt 汇率同步正常（USD 行今日 09:51 更新）。

### 下一步

1. 史哥在商城前台走一笔「购买卡密」到收银台页面目视确认（$15 → ≈15 USDT），不实际支付。
2. 将「Epay 插件含 fiat=USD」加入 `tools/xboard-patch-check.js` 核查清单，防容器重建后静默丢失。

## v1.25.0 · 2026-10-13 · 对外分销 API + API 客户管理：双模式定价落地（API 加价分销侧）

- 背景：用户确定商业模式后开工——"客户平台直购固定价 + API 按上游价加价分销"。本版落地**分销侧 MVP**（固定零售价侧已在 v1.24.0 完成）。
- 对外 API（`/api/open/v1/*`，与内部 `/api/integration/*` 隔离）：`GET /catalog`（目录含当前报价）/ `POST /quote`（60 秒锁价，成本 + 加价实时算）/ `POST /orders`（幂等 `client_order_no` + 锁价校验 + 余额原子扣减 + **同步履约发卡**，复用 `store.issueCdkByRef`）/ `GET /orders/:orderNo`（查单含卡密）。
- 鉴权与防线：API Key + HMAC-SHA256 签名（`METHOD\npath\ntimestamp\nsha256(body)`）+ 时间戳 5 分钟窗口防重放 + 恒时比较 + 限流（默认 120 次/分钟，客户级可配）；全局 `express.json` 加 `verify` 保存 rawBody 供签名校验。
- 锁价机制：报价锁定成本；下单时成本变动 >3% → `409 PRICE_CHANGED`（附新价）——防"上游涨价瞬间按旧价成交"。
- 计费：预充值余额（`UPDATE ... WHERE balance >= amount` 原子扣减；履约失败自动退回）。
- 管理面（KC 后台新「API 客户」页）：客户列表（key/余额/状态/用量/GMV）+ 新建（一次性展示 key/secret + 签名规则）+ 充值 + 停用/启用 + 查看凭证。
- 成本配置（UX-4）：上游管理 →「查看目录」→ 每行「设成本」按钮（写 `kc_upstream_plans.upstream_price_cents`）——API 加价的成本来源。
- 数据：新增 `kc_api_clients` / `kc_api_orders` / `kc_api_quote_logs` 三表（mysql-store 自动建）。
- 验证（双轨全绿）：
  - 接口层 `tools/_v125_verify.js`（纯 HTTP 签名流）：catalog $11.50 → quote → 上游涨价后旧报价下单 **409 PRICE_CHANGED**（新价 $12.65）→ 重新报价 → 下单拿到卡密（`KC-KGGEEKY9ASQ5ND9`）→ 幂等重发（同单号回原单 + 同卡密）→ 查单 → 余额 $500 → **$487.35 精确扣减** → 坏签名 / 时间戳过期 / 无鉴权头均 401 ✓
  - UI 层 `tools/_v125_verify_ui.js`：API 客户页（列表/空态）→ 新建客户弹窗（返回 key/secret + 签名说明）→ 充值 $0 → $100 → 上游目录「设成本」按钮与 $10.00 显示 ✓
- 部署：server.js + mysql-store.js + admin.html（挂载，KC 容器重启）；测试客户/订单/报价/发卡残留已清理。
- 演示状态：xplan_1（ChatGPT Plus）API 分销已开（成本 $10 / 加价 15% → 报价 $11.50），可在「商品管理 → 编辑」调整。
- 下一步（后续版本）：客户级加价覆盖、交付回调 webhook、成本自动同步（真实上游价）、报价日志后台可视化。

### v1.24.0 · 2026-10-13 · 商品管理 MVP：一个页面配商品，保存即同步商城

- 背景：用户反馈"配置商品太难"（跨 2 后台 4+ 页面、填技术码、配了不生效）。以产品专家视角把《商品配置体验重构》与《双模式定价与对外分销 API 设计》两份方案**精简为 MVP 并执行**：先解决"一个页面、一次保存、立即可买"。
- 交付（KC 后台新增「商品管理」页，原生表单，无框架依赖）：
  - **列表**：商品名（+ID）/ 售价（$ 与周期）/ 货源 / 状态（在售 + 商城显示）/ API 分销配置 / 编辑；一行一商品，全程无技术码。
  - **编辑与新建（单表单）**：商品名称* / 计费周期（月付 / 一次性）/ 售价（美元）* / 货源（下拉：不绑·plus·pro_5x·pro_20x —— 与插件自动发卡白名单一致）/ 一句话卖点 / 商品说明 / 排序 / 在售与商城显示开关 / API 分销定价（加价幅度，配置存储，对外接口 v2 启用）。
  - **「保存并同步商城」一次完成**：`xboard.v2_plan`（名称 / prices / 显示 / 可售 / kc_card / 说明）+ `kc_plans`（货源绑定 / API 配置）+ `kc_pricing_rules`（manual 价替换）+ `kc_listing_cards`（同步）+ **`v2_plugins.config.packages` 映射**（订阅类自动写 —— 新商品下单即可自动发卡）。
  - 菜单收敛：「商品管理」取代原「商品与资费」「商品卡片」入口（两者菜单隐藏、页面保留直连）。
- API（server.js 新增 2 条，均 `requireSecondaryAuth` 且幂等）：`GET /api/admin/products`（v2_plan × kc_plans 聚合列表）+ `POST /api/admin/products/save`（聚合保存）。
- 数据（mysql-store.js）：`kc_plans` 新增 `api_enabled` / `api_markup_percent`（幂等 ALTER，配置占位列）。
- 验证：`tools/_v124_verify.js` 端到端**全绿** —— 编辑预填（名称/售价/货源/卖点全对）→ 改价 15→16 → `v2_plan.prices={monthly:16}` + `kc_pricing_rules=1600` 双写 ✓ → 改回 15 ✓ → 新建测试商品 → `v2_plan(id=16)` / `kc_plans(xplan_16, mock_zovo/plus, api 12%)` / `packages_key=plus` / 资费 50 分 全部落位 ✓ → 测试数据清理（v2_plan + kc_plans + pricing + packages 键）✓；截图与报告 `logs/v124-verify/2026-10-13T00-48-02-720Z/`。
- 部署：server.js + mysql-store.js + admin.html（均为挂载文件，重启 KC 容器加载）；验证后列表保持 10 商品原样（无脏数据）。
- MVP 边界（明确留待后续版本）：3 步向导 / 报价模拟器（体验版）、对外 Open API（quote/orders/API 客户管理，UX-5/6）、成本同步（UX-4）——见两份方案文档。
- 下一步：在 KC 后台「商品管理」实用：改一个商品的价格、或新建一个商品，保存后到商城商品页验证即时生效。

### v1.23.1 · 2026-10-13 · 修复：新增套餐「元/月」残留 + 上游/资费入口链路修正

- 背景：用户反馈两问题——①「新增套餐有『元/月』等明显问题」②「后台里上游管理、资费管理一个也没有」。以双站实测走查（Xboard 添加套餐弹窗 + KC 后台登录走查 + i18n 根源扫描）完成根因定位后修复。
- **问题①（元/月残留）根因与修复**：
  - 根因：价格后缀「元/月」来自 i18n 键 `subscribe.plan.columns.price_period.unit.month`（共 7 个 unit 键 × 2 份命名空间，值为「元/月/季/半年/年/两年/三年/次」）；上轮 V2.1 的「数字+元」正则只覆盖**同一文本节点**，而实际 DOM 拆分为 `['月付','$','15','元/月']` 多节点 → 未命中。
  - 修复：i18n 覆盖 14 个 unit 键 → `/月 /季 /半年 /年 /两年 /三年 /次`；`settings.invite.commission_withdraw_limit.title` → 「提现单申请门槛($)」。
  - 体验优化：隐藏「两年付 / 三年付」价格行（代充品类无超长周期商品；保留 月/季/半年/年/充值包）。
  - 验证：价格节点序列 `月付 | $ | 15 | /月`（视觉「月付 $15/月」）；全站可见文本"元"字 0 残留（断言词典加固 `元/`）；添加套餐弹窗 label：套餐名称/标签/月付/季付/半年付/年付/充值包/套餐说明。
- **问题②（上游/资费"一个也没有"）三层根因与修复**：
  - 原因1（入口误导）：Xboard 后台「代充运营」链接原先指向 `:3100/business-admin`——独立轨道 Mock 运营台（冻结版，不含上游/资费）；已修正为 `:3100/admin`（KC 后台——上游/资费/卡片/权益的真正所在地）。
  - 原因2（数据缺失）：`tools/migrate-upstreams.js` **从未成功执行过**——脚本经 mysql-store 连接，本机运行缺 DB_PORT（默认 3306 被拒）。修复脚本（自动加载 .env + 默认 3310，本机可跑）后回填成功：1 上游（`mock_zovo`）+ 12 条套餐目录；「上游管理」页现有完整数据（套餐数 12 / healthy）。
  - 原因3（命名差异）：菜单更名对齐运营语言——「上游接入」→**「上游管理」**、「商品 SKU」→**「商品与资费」**（`public/admin.html` 8 处 + `server.js` 2 处，含页面标题与提示）。
- 验证：`tools/check-admin-airport.js`（词典新增 `元/`）**33 PASS / 0 FAIL / 0 词典命中**；KC 后台实测：侧栏四菜单（上游管理/商品与资费/商品卡片/权益）+ 上游页数据 + 10 SKU 列表；价格视觉「$15/月」。
- 部署：Xboard 壳层（blade 挂载即生效 + view:clear）；KC 容器重启（server.js 提示文案变更）；上游回填报告 `logs/migrate-upstreams-report.json`。
- 下一步：用户在 KC 后台（`http://localhost:3100/admin`）复核「上游管理 / 商品与资费」两页；后续可考虑把 KC 后台运营四页的入口也注入 Xboard 后台壳层（不用跳转即达）。

### v1.23.0 · 2026-10-12 · Xboard 管理端代充化：运行时过滤器（i18n 覆盖 + 菜单收敛 + 字段过滤）

- 背景：继 v1.22.0 前台修复后，以运营管理员身份实测 **Xboard 管理端**（`/5fea4ca1`，17 页走查 + DOM 精探 + 编译包审计）——发现菜单分组 / 仪表盘流量卡 / 表格机场列 / 文案 / 货币 / 品牌共六类机场语义残留，本次全部处置。
- 引擎（`resources/views/admin.blade.php` 壳层注入「KC-ADMIN-V2」三层过滤器；volume 单文件挂载，改本地即生效）：**① i18n 覆盖**（主模块执行前改写 `window.XBOARD_TRANSLATIONS['zh-CN']`）+ **② 菜单收敛**（路径黑/白名单 + 空组整组隐藏）+ **③ 字段过滤**（可见文案精确匹配）+ **④ 文案兜底**（品牌 / 货币）；只隐藏（display:none）不删除节点；心跳 1.5s + MutationObserver(250ms) + hashchange 三重自愈；幂等可重跑。
- 落地清单：
  - i18n：订阅管理→**商品管理**（侧栏组）、订阅套餐→**商品套餐**、订阅计划→**商品名称**、周期→**服务周期**（值映射 月付→30 天 / 一次性→单次 / 季→90 / 半年→180 / 年→365）、流量包→**充值包**、订阅→**当前商品**（用户列/编辑/筛选/弹窗）、支付/系统/邮件提醒描述中性化、套餐说明模板换为代充版。
  - 菜单：优惠券 / 礼品卡 / 服务器 / 节点 / 权限组 / 路由 / 主题 / 插件 / 知识库隐藏；「节点管理」空组整组隐藏；保留原位注入「代充运营」运营入口链接。
  - 表格列隐藏：权限组 / 在线设备 / 已用流量 / 总流量 / 下次重置时间 / **到期时间**（用户列表）。
  - 表单行隐藏：流量 / 速度限制 / 设备限制 / 容量限制 / 流量重置方式 / 重置包 / 服务器分组 / 注册试用 / 订阅URL / 订阅链接 / 折抵金额。
  - 页签隐藏：订阅设置 / 节点配置 / 订阅模板（系统设置页）。
  - 卡片隐藏：月上传 / 月下载 / 节点流量排行 / 用户流量排行（仪表盘）。
  - 弹窗区块与行菜单：订阅信息 / 流量信息区块隐藏；复制订阅URL / 重置UUID及订阅URL / 重置流量 / TA的流量记录隐藏。
  - 文案兜底：品牌 Xboard→**KC 加速**（与前台登录卡白标一致）；货币 ¥→$（含全角 ￥ 与「数字+元」清理）；站点名称/描述经 `Setting::set('app_name'/'app_description')` 正规写入（清 Redis 缓存）。
- 验证：新增断言工具 `tools/check-admin-airport.js`（真实登录 → 8 保留页 + 6 系统页签 + 行菜单 + 套餐编辑弹窗 → 真正可见文本采集（display:none/visibility 祖先链排除）→ 机场词典 + 33 项专项断言）——**33 PASS / 0 FAIL / 0 词典命中**（报告 `logs/admin-airport/2026-10-12T16-45-37-822Z/report.json`）。关键复验点：套餐弹窗机场字段全隐藏、「充值包」双行归位、¥→$ 与「元」清理、到期时间列消失、邮件提醒文案。
- 部署：`admin.blade.php` 4,811 → 16,023 bytes（+ 基线备份 `.bak_pre` 与快照 `tools/xboard-patches/admin.blade.php`）；本地 = 容器（bind mount 同一文件）。审计用测试账号提权（is_admin 1→0）已还原。
- 工具链：注入模板 `tools/_v123_admin_inject_script.html.tpl`（单一源）+ V2/V2.1/V2.2/V2.3 补丁脚本（均幂等、带语法校验与快照联动）。
- 方法学备注：管理端截图**不用 captureBeyondViewport**（全页截图会触发重排 → React 重建表格 → 捕捉到过滤器自愈前的瞬间，产生「未生效」假象）；运行时实测（display 状态 + 手动对照实验）才是真相。
- 下一步：`admin.blade.php` 在 Xboard 仓库未提交（M 状态）；KC 仓库本轮改动待提交；后端菜单策略与壳层收敛的完全统一（AdminMenuController 策略清单驱动壳层渲染）另开排期。

### v1.22.0 · 2026-10-12 · 全站机场字段屏蔽与代充化替换（实测走查版）

- 背景：用户反馈订单详情页残留机场字段（`类型/周期`、`产品流量`）。研发侧先做 headless 实测走查（全站 12 个可达面 + 下单全生命周期），产出 **9 项体验问题 + 8 项决策**（方案稿 `docs/方案/机场字段全站屏蔽与代充化替换-v1.1.0.md`），本次全部落实。
- 引擎（`kc_theme_inject.html` 新增 S4 段）：**文案精确整段匹配的运行时字段过滤器**——行级（label:value）/ 列级（表格 th）/ 节点级（按钮）/ 卡片级（n-card 标题）；只隐藏不删除 Vue 节点；幂等（已达标跳过）；多触发自愈（boot + hashchange + 订单页 800ms×15 轮询 + 全局 1s 心跳 + MutationObserver childList 防抖 80ms，禁用 characterData）。
- 落地清单（9 项问题全处置）：
  - 订单详情：`类型/周期` →「**服务周期**」（值映射：月付→30 天 / 季付→90 / 半年付→180 / 年付→365 / 两年付→730 / 三年付→1095 / 一次性→单次）；`产品流量` →「**交付方式：卡密自动发放**」；「查看使用教程」按钮隐藏；`旧订阅折抵金额`/`折抵` 行隐藏。
  - 订单列表：「周期」列 →「**服务周期**」+ 值映射（30 天 / 单次）。
  - 个人中心：「**重置订阅信息**」整卡隐藏；「**通知**」卡（到期邮件提醒 / 流量邮件提醒）整卡隐藏。
  - 菜单：头像下拉 + 移动抽屉移除「使用文档 / 节点状态 / 流量明细」三个机场入口。
  - 路由：`#/node`、`#/traffic` 直连（含刷新）与 SPA 跳转 → 静默重定向 `#/dashboard`。
  - 货币守护扩展：显示面独立「CNY」文本 → 「USD」（覆盖订单总额「$ 0.00 CNY」、钱包「24.44 CNY」场景）；并入既有 1.5s 货币心跳。
  - 文案代充化三处：门户热门套餐卡按钮「立即订阅」→「立即办理」；充值面板提示去掉「与订阅」。
- 验证：新增 L4 断言工具 `tools/check-airport-lexicon.js`（真正可见文本采集 + 机场词典 + 12 项专项断言）——**19 / 19 全 PASS**：全部页面 0 机场词命中；列表「服务周期」；详情「服务周期：30 天」「交付方式：卡密自动发放」；个人中心两卡消失（只剩 我的钱包 / 修改密码）；菜单三项消失；node/traffic 重定向生效；游客落地干净。
- 部署：custom_html 257,123 → 276,884 字节，本地三源拼接与线上 md5 逐字节一致（`0a6cd3f2…`）；**连带部署 v1.14 主题增量**（优惠行 / 类型标 / 游客套餐区，此前因 Docker 故障滞留未上线）——实机核验：类型标已显示（商品页「代充」标）、游客浏览与订单/个人中心链路正常。
- 工具与证据：`tools/_v122_ff_patch.js`（幂等补丁脚本，含重复注入检查）；走查证据 13 张截图 + 3 份报告（`logs/ff_trial/`）；断言报告 `logs/airport-lexicon/2026-10-12T15-22-18-964Z/report.json`。
- 观察（记录不改）：已完成订单副标题「订单已支付并开通。」与底部「代充开通 · 待开通」存在轻微口径张力（native 文案，改动性价比低，暂缓）。

### v1.21.0 · 2026-10-11 · 后台解耦 R7：老字段下掉评估报告 + 数据健康诊断

- 评估报告：`docs/方案/老字段下掉评估-v1.0.0.md`（首版）。TL;DR：`xboard.v2_plan` ↔ `plus_papay.kc_plans+kc_pricing_rules+kc_listing_cards` **10/10 plans 全匹配**（2026-10-11 实测），数据层已具备下掉老字段的客观条件；但**主观条件**（插件切读法 + 前台切读法）尚未完成，**本期不实际下掉**。
- API：`GET /api/admin/diag/legacy-fields` —— 后台一键查双轨差异（需 `requireSecondaryAuth`），返回 ready_to_drop_legacy 决策布尔 + 逐 plan 不一致列表。
- 离线检查：`tools/check-legacy-readiness.js` —— 比对 v2_plan 与 kc_* 新表，输出 `logs/legacy-readiness.json`；exit code 0=ready / 1=有差异 / 2=FAIL；适合 CI/CD 接入。
- 决策路径（评估稿 §五）：v1.21.0 稳定运行 ≥ 1 个小版本后，在 v1.22.0+ 启动 R7 续作（完成 BFF 代理 + 前台切读法后再 DROP COLUMN）。
- 文档：VERSION.json→v1.21.0；产品全景/CHANGELOG/README 同步。
- 自测：`check-legacy-readiness.js` PASS：10 matches / 0 mismatches / 0 kc_only / 0 legacy_only；`node --check` 全过。

### v1.20.0 · 2026-10-11 · 后台解耦 R6：权益高级·事件型权益 + 动作钩子

- 数据：KC 数据库新增 1 张表（`mysql-store.js` 自动建）—— `kc_entitlement_actions`（user × rule_code × action_code × handler × target_plan_code × params_json × status × result_json 动作流水）；索引 idx_user/idx_rule/idx_action。
- API：
  - `POST /api/integration/entitlement/event` —— 集成端点（X-Integration-Key 公开鉴权）。Body `{user_id, event_code, target_plan_code?, params?}`；按 `kc_entitlement_rules` 中 source='event' 的规则匹配（先精确 event_code，再回退到 '*' 通配），逐条执行 handler。
  - `GET /api/admin/entitlements/actions?user_id=` —— 后台查询用户动作流水。
  - 内置 handler：`audit_log`（仅写动作流水 status=success）/ `plan_switch`（写动作流水 status=skipped + result.note 标注"v1.20.0 仅记录计划不实切换；实切换留 v1.21+"，避免越权）。handler 选择通过 rule.note 中的 `handler=xxx` 配置；target 通过 `target=xxx` 读取。
- 后台：权益页"按 user_id 查询"扩展为同时展示 grants + actions 两张表（事件动作流水带 status badge 与 result 摘要）。
- 回填脚本：`tools/migrate-entitlements.js` 加 2 条 event 源 demo 规则（`plus_purchase_event_audit` audit_log + `plus_purchase_upgrade_intent` plan_switch）。
- 文档：VERSION.json→v1.20.0；产品全景/CHANGELOG/README 同步。
- 自测：`tools/_v120_r6_e2e.js` 端到端 PASS（6 阶段）：plan_purchased 事件精确匹配 2 条规则 + user_login 事件通配 1 条 + DB 3 行流水 + 鉴权失败 + 字段校验失败。`node --check` 全过。

### v1.19.0 · 2026-10-11 · 后台解耦 R5：权益高级·插件协作自动发权益 + 退款回补

- 集成端点（公开鉴权 X-Integration-Key）：
  - `POST /api/integration/entitlement/issue-after-cdk` —— 插件发卡成功后回调，按 plan_code 查 status='active' AND source='purchase' AND trigger_plan_code=plan_code 的规则，给下单 user 自动下发 grant；多规则按 priority DESC；幂等（uk_user_rule_active + INSERT IGNORE）。
  - `POST /api/integration/entitlement/refund` —— 退款/失败回补，按 grant_id + order_trade_no 幂等回滚一次扣次（mark note=REFUNDED + grant.remaining_uses + 1 + exhausted→active）。
- 插件：`KcIntegration/Plugin.php` 在发卡成功处（`$result['ok']`）增加 `callKcEntitlementIssueAfterCdk` 调用，**失败仅日志不阻塞主路径**（订单已成功）；同步到快照 `tools/xboard-patches/KcIntegration/Plugin.php`（Xboard 仓库 `plugins/` 被 git 忽略，快照是唯一版本化备份）。
- DB 补列：`kc_entitlement_uses` 补 `note VARCHAR(255)` 列（ALTER 容错处理兼容老部署）。
- 回填脚本：`tools/migrate-entitlements.js` 加 1 条 purchase 源 demo 规则 `plus_purchase_off20_grant`（购买 plus 自动发 30 天有效期 8 折权益）。
- 文档：VERSION.json→v1.19.0；产品全景/CHANGELOG/README 同步。
- 自测：`tools/_v119_link_e2e.js` 端到端 PASS（9 阶段）：注册→下单→支付回调→发卡→issue-after-cdk→grant 落库（grant_id=3, source='purchase', source_ref=order:trade_no:cdk）→DB 一致性→refund→回补验证（remaining_uses 0→1, status exhausted→active）。`node --check` 全过；R5 标记 8 项全命中。

### v1.18.0 · 2026-10-11 · 后台解耦 R4：权益 MVP（价格型）+ 自动发权益基础设施

- 数据：KC 数据库新增 3 张表（`mysql-store.js` 自动建）—— `kc_entitlement_rules`（规则定义 code UNIQUE / discount_type 三类 × discount_value × 门槛 × 配额 × 有效期 × 优先级 × 适用范围 plan_scope × source/trigger_plan_code × 有效期）、`kc_entitlement_grants`（用户持有，uk_user_rule_active + INSERT IGNORE 防并发同 user 同规则多发）、`kc_entitlement_uses`（扣次流水，uk_grant_order 幂等防同 grant 同单重复扣次）。
- API：6 条 `/api/admin/entitlements/*`（list/create/patch rules + /issue 发 grant + /revoke + /grants 查询 user 持有）。统一 `requireSecondaryAuth`，归一化函数 `ruleCodeNorm`/`ruleStatusNorm`/`discountTypeNorm`/`ruleNorm`；`entitlementGrantIssue` 公共函数（admin 与 R5 集成钩子共用入口）。
- 价格引擎：`POST /api/pricing/quote` v1.18.0 起**启用 entitlement 分支**——查询 user 的 active grants，按 discount_type 计算最终价，与 manual/promotion 候选比价取低；snapshot_json 增加 `entitlement` 字段；返回新增 `applied_grant_id`。
- 后台页：运营壳菜单新增「权益」顶级项（lucide-ticket-percent 图标）；卡片列表 + 状态过滤 + 新建/编辑/暂停/启用/发权益/撤销/按 user_id 查询；UI 集成于既有 design tokens。
- 回填脚本：`tools/migrate-entitlements.js`（幂等可重跑，导入 2 条 demo 规则：`plus_member_off20` percent 20% + `pro_newuser_fixed50` fixed_cents 50 cents）。**不动** 插件钩子（订单触发自动发权益基础设施已留位，R5 接入插件协作）。
- 文档：VERSION.json→v1.18.0；产品全景新增「权益」行 + 锚点 `feat:entitlements`；CHANGELOG 顶部追加；README 同步。
- 自测：`node --check server.js` 与 `mysql-store.js` 通过；后台脚本 0 错误；`node tools/check-docs-sync.js` 15/15；权益相关 14 项 marker 全命中；3 张表已建 + 2 条规则已回填（rows=2/0/0）。

### v1.17.0 · 2026-10-11 · 后台解耦 R3：商品展示层独立 + 双轨兜底

**一句话概括**：把"商品"概念中"前台展示成什么样子"那部分从 v2_plan.kc_card 拆出 —— 后台新增「商品卡片」页基于 KC 视图 SKU 编辑，独立存 `kc_listing_cards`；提供"全部同步到 v2"一键双写兜底让插件立即读到新配置；**终极方案（插件改读 KC 侧）留给 R3 续作**。

### 新增
- KC 数据库新增 `kc_listing_cards` 表（plan_id PK + card_json + is_visible + listing_state + sort + updated_at；`mysql-store.js` 自动建）。
- 后台 API 4 条（`/api/admin/listing-cards*`）：`GET 列表（含默认 card）`、`PUT 保存（upsert by plan_id）`、`POST 可见性切换`、`POST sync-to-v2 双写兜底（按 kc_plans.code='xplan_<v2id>' 映射回写 xboard.v2_plan.kc_card）`。
- 后台页「商品卡片」（运营壳菜单顶级项 / `lucide-credit-card` 图标）：列表卡片（标题/副标题/类型标/优惠行/可见性摘要）+ 「编辑」弹窗（含标题/副标题/状态/排序/类型标/划线原价/促销文案/权益清单/提示行/底部服务链接）+ 「显示/隐藏」开关 + 顶部「全部同步到 v2」按钮。
- 数据回填脚本 `tools/migrate-listing-cards.js`（幂等可重跑）：从 `xboard.v2_plan.kc_card` 回填到 `kc_listing_cards`，按 `kc_plans.code='xplan_<v2id>'` 建立 plan_id 映射；**不动** `v2_plan.kc_card`；报告落 `logs/migrate-listing-cards-report.json`。

### 修改
- 落地策略保守：**R3 完成后 KC 侧三页（上游接入 / 商品 SKU / 商品卡片）齐跑**，**未改插件读法** —— `PlanCardController` 仍读 `v2_plan.kc_card`；R3 续作时改插件读 KC 侧（按方案 SP-2026-10-11-v1.0.1 §7 M3 双轨读）。
- 双轨兜底：后台顶部「全部同步到 v2」按钮调 `sync-to-v2` 把当前 kc_listing_cards 一次性写回 v2_plan.kc_card，**让插件立即读到新配置**（无需重启插件 / 容器）。

### 验证
- 静态：`node --check server.js` 通过；后台脚本 `new Function` 解析 0 错误；展示层相关 marker 全在（`listingStateNorm`、`/api/admin/listing-cards`、`sync-to-v2`、`kc_listing_cards`、`LISTING_CARDS_TABLE_SQL`、`loadListingCards` 等）。
- 数据：`tools/migrate-listing-cards.js` 一次成功——10 张卡片插入（其中 1 张来自 v2_plan.kc_card 非空内容、9 张用默认模板）；幂等可重跑；映射零跳过（10/10）。
- `docker restart kc-gpt-pay2-app` 后 KC 容器 2 秒恢复 200；`/api/integration/health` sellable=true 未受影响。
- `node tools/check-docs-sync.js` 通过；`node tools/check-currency.js` 全绿（amount_cents → $ 守护兼容）。

### 影响与风险
- **未改插件读法**：当前生效配置仍是 v2_plan.kc_card；后台保存 kc_listing_cards 后必须点「全部同步到 v2」才生效（这是有意收紧的边界，下游流程可见可控）。
- `sync-to-v2` 是写库操作（Xboard 库），有 confirm 确认；映射按 `code='xplan_<v2id>'` 解析，跳过无映射的（不回写）。
- 后台三页 R1+R2+R3 独立运作，互不耦合。

### 下一步
- 用户确认后开 R3 续作（插件改读 KC 侧）：改 `PlanCardController::index()`，先读 `kc_listing_cards`（通过 KC API 或直连 plus_papay），无则回退 `v2_plan.kc_card`；同步快照 `tools/xboard-patches/KcIntegration/`。
- 或进入 R4（权益 MVP）：`kc_entitlements*` 表 + 后台「权益」页 + 价格引擎权益分支。

---

## v1.16.0 · 2026-10-11 · 后台解耦 R2：资费层独立 + 价格引擎 quote

**一句话概括**：把"商品"概念中承载"卖多少钱"的那部分抽离成独立配置面 —— 后台新增「商品 SKU」页，可视化管理 KC 视图 SKU（引用上游套餐键）与资费规则（manual/promotion/entitlement 三类来源 + priority + 有效期），支持整体替换与价格预览；新增 `POST /api/pricing/quote` 价格引擎，落单时固化 snapshot 保证退款可复算；R2 与 R1 同步保持 R3 才真正切换前台读法的保守边界。

### 新增
- KC 数据库新增 3 张表（`mysql-store.js` 自动建）：
  - `kc_plans`：KC 视图 SKU（code UNIQUE、kc_type='recharge'/'account'/'entitlement'、upstream_code + plan_key 引用上游、status=active|paused|archived）；
  - `kc_pricing_rules`：资费规则（plan_id + source + period + amount_cents 美分数 + priority + valid_from/until + enabled），按 priority DESC + 同优先级 manual>promotion>entitlement 排序；
  - `kc_order_pricing_snapshot`：订单价格快照（trade_no UNIQUE、base/final cents、applied_source/rule_id、snapshot_json），`quote` 调用时按 trade_no 幂等 upsert，保证退款按当时规则金额走。
- 后台 API 7 条（`/api/admin/plans*`）：`GET 列表`、`POST 新建（校验上游套餐键）`、`PATCH 更新`、`GET 资费规则`、`PUT 整体替换`、`POST 价格预览`、`POST /api/pricing/quote` 价格引擎（按 plan_code 入参）。
- 后台页「商品 SKU」（运营壳菜单新增顶级项 / `lucide-package` 图标）：列表卡片（含类型标/状态/规则数/上游引用）+ 「新建 SKU」「暂停/启用」「资费规则」「整体替换」「价格预览」操作（统一弹窗，价格预览 inline 表格）。
- 数据回填脚本 `tools/migrate-pricing.js`（幂等可重跑）：从 `xboard.v2_plan.prices` 与 `v2_plugins.config.packages` 迁移 10 个 SKU（订阅 1 + 充值 9）→ `kc_plans` + 10 条 manual 规则；**未改** `v2_plan.prices` 与 `kc_topup_amount`（R3 切换读法时再下架）；报告落 `logs/migrate-pricing-report.json`。
- `priceQuote()` 函数（server.js 内部工具）：按 plan_code + 有效期内规则取最优命中（priority DESC → 同优先级 manual>promotion>entitlement），同时落库 snapshot。

### 修改
- 落地策略保守：**R2 仅 KC 侧独立管理 + 后台可视 + 价格引擎就绪**；**未改** 插件 `config.packages` 与前台商品页——R3 展示层时统一切读法（按方案 SP-2026-10-11-v1.0.1 §7 M3 双轨读）。
- `PUT /api/admin/plans/:id/pricing` 当前拒绝 `source='entitlement'`（R4 启）；R2 仅 manual/promotion 走通规则。

### 验证
- 静态：`node --check server.js` 与 `node --check mysql-store.js` 通过；后台脚本 `new Function` 解析 0 错误；资费相关 9 项 marker 全在（`/api/admin/plans`、`/api/pricing/quote`、`kc_plans`、`kc_pricing_rules`、`kc_order_pricing_snapshot` 等）。
- 数据：`tools/migrate-pricing.js` 一次成功——10 SKU + 10 manual 规则（订阅 plan 1 = 1500 cents/月 绑 mock_zovo/plus；9 个充值类 = once 周期绑 kc_topup_amount 直接写入）；幂等可重跑。
- 真机部署：`docker restart kc-gpt-pay2-app` 让 `ensureReady` 跑一次建新表；KC 容器 2 秒恢复 200；`/api/integration/health` sellable=true 未受影响。
- `node tools/check-docs-sync.js` 通过；`node tools/check-currency.js` 全绿（amount_cents → $ 守护兼容）。
- **价格引擎 quote 端到端**：admin 登录与 quote 实测待人工执行（脚本路径见 `tools/_v115_link_e2e.js` 的 admin 凭据获取模式，**不随脚本写 .env**）。

### 影响与风险
- 仍是基础设施：**没有真正"调价生效"** —— R2 + R1 完成后 KC 后台三个新页齐跑（上游接入 / 商品 SKU），价格引擎 quote 已就绪，但插件 `order/save` 仍走原链路；R3 切换时由 BFF 代理接入。
- R2 暂禁权益价（`PUT` 拒绝 `source='entitlement'`）；R4 启后去掉此校验。
- 数据回填脚本需手动执行一次（幂等可重跑）；未做自动迁移以避免与 R1 顺序耦合。

### 下一步
- Docker 引擎恢复后：跑 `node tools/migrate-pricing.js`（已跑一次，10 SKU+10 规则）；admin 登录后实测 `POST /api/pricing/quote {plan_code:'xplan_1'}` → 期望 final_cents=1500、applied_source='manual'、snapshot 落库。
- 用户确认后开 R3（展示层独立）：`kc_listing_cards` 表 + 插件 `PlanCardController` 改读新表 + 商品页卡片配置双轨。

---

## v1.15.0 · 2026-10-11 · 后台解耦 R1：上游接入层独立

**一句话概括**：把"商品"概念中承载"上游是谁、卖什么"的那部分抽离成独立的后台配置面 —— 后台新增「上游接入」页，可视化管理上游身份与目录、暂停/启用、刷健康、目录导入（幂等）；为后续 R2 资费层 / R3 展示层独立铺路。换上游的方式从"改插件 config + 重打补丁"变为"后台新建 code / 暂停旧 code"。

### 新增
- KC 数据库（`plus_papay`）新增 3 张表（`mysql-store.js` 自动建）：
  - `kc_upstreams`：上游身份（code UNIQUE / display_name / protocol='mock'/'rest'/'custom' / status='active'/'paused'/'archived' / base_url / api_key_ref / config_json / note）；
  - `kc_upstream_plans`：上游目录（UNIQUE(upstream_code, upstream_plan_key)，含 sku_type='subscription'/'topup'/'credit'、period、upstream_price_cents、is_credit、requires_active_subscription、enabled）；
  - `kc_upstream_health_snapshots`：健康快照（兼容 v1.11.3 supplier-health.js 字段；按 upstream_code 聚合最新一条）。
- 后台 API 6 条（`/api/admin/upstreams`）：`GET 列表（含健康）`、`POST 新建`、`PATCH 更新（暂停/启用/改配置）`、`GET 目录`、`POST 目录导入（JSON 数组，upsert 幂等）`、`POST 健康刷新（Mock 探活，未真实调用上游）`。
- 后台页「上游接入」（运营壳新增顶级菜单项 / `lucide-server-cog` 图标）：列表卡片（含状态徽章 / 协议 / 套餐数 / 健康）+ 「查看目录」展开表格 + 「暂停/启用」「刷健康」「新建」「导入目录」操作（统一弹窗）。
- 数据回填脚本 `tools/migrate-upstreams.js`（幂等可重跑）：写入 `mock_zovo` 上游与 12 条 mock 目录（与 `zovocard-client.js` MOCK 一致），**不动** `plugins.config.packages`（R3 展示层时再切读法）；报告落 `logs/migrate-upstreams-report.json`。

### 修改
- 落地策略保守：**R1 仅 KC 侧独立管理 + 后台可视**，**未改动** `plugins.config.packages` 与前台套餐页——降低 R1 风险；R3 展示层时统一切插件读法（按方案 SP-2026-10-11-v1.0.1 §7 M3 双轨读）。

### 验证
- 静态：`node --check server.js` 与 `node --check mysql-store.js` 通过；后台脚本 `new Function` 解析 0 错误；上游相关 7 项 marker 全在（`UPSTREAMS_TABLE_SQL`、`/api/admin/upstreams`、`/plans/import`、`/health/refresh` 等）。
- 数据：回填脚本可重跑（`INSERT ... ON DUPLICATE KEY UPDATE`），幂等；不动 Xboard 库表。
- `node tools/check-docs-sync.js` 通过（v1.15.0 三处版本号一致）；`node tools/check-currency.js` 全绿（上游价展示走 `cents→$` 守护）。
- **全链路端到端（KC↔Zovo(MOCK)↔Xboard）首次跑通**：`node tools/_v115_link_e2e.js` 一次通过——注册 Xboard 真实用户 → 建真实单（plan_id=1, month_price）→ 投递模拟到账回调（BEpusdt 同款 MD5 签名）→ 订单 `status=3`、插件 `status='issued'`、CDK 即时下发（`KC-4F4LEDEW33C52Z4`）、`integration_cdk_issue` 落行、`cdk_codes.type='自助'`；幂等复验通过（重发 cdk/issue → `reused=true`+同 CDK；重复 notify → 200 success 不重复发卡）；报告落 `logs/v115-link-e2e-report.json`。零真实扣款。

### 影响与风险
- 仍是基础设施：**没有真正"换上游"在线生效**，仅后台可视；切换流程等 R3（数据双轨切换）—— 这是有意收紧的边界。
- 数据回填脚本需 `node tools/migrate-upstreams.js` 手动执行一次（幂等，可重跑）；未做成自动迁移以避免冷启动期多并发写。
- `config_json` 字段暂留空（上游特定配置未来按需启用）。

### 下一步
- Docker 引擎恢复后：跑一次 `migrate-upstreams.js` → 后台打开「上游接入」页确认 mock_zovo + 12 目录；UI 截图归档。
- 用户确认后开 R2（资费层）：`kc_plans` / `kc_pricing_rules` + 后台「商品 SKU」+ `pricing/quote` MVP。

---

## v1.14.0 · 2026-10-11 · 商品页游客浏览开放与优惠行、类型标配置化

**一句话概括**：商品页对未登录游客开放浏览（游客与登录用户看同一套商品与卡片配置，只有购买动作需要登录）；商品卡新增「类型标」（右上角小标，文案与颜色可配）与「优惠行」（划线原价 + 促销文案），并给优惠行配了一键关闭的**全局开关**（关闭后全站优惠行立即消失、单卡文案保留）；底部服务链接（chips）能力保留但**默认不显示**；品牌水印按决策不做。

### 新增
- **游客浏览商品页**：未登录访问商品页不再只是落地页静态套餐，改为读取真实在售商品（免登录商品接口）+ 同一套卡片配置渲染完整套餐区；每张卡的按钮为「登录后购买」，点击引导登录并保留购买意图。
- **类型标**（商品卡右上角）：后台可配文案与颜色（品牌绿 / 绿 / 橙 / 灰）；留空时按商品分类缺省（如代充），未配置即不显示。
- **优惠行**（价格下方）：后台可配划线原价与促销文案，并带**单卡开关**（隐藏但保留文案）与**全局开关**。
- **优惠行全局开关**：运营后台商品卡片配置页顶部一键切换，切换即存、无需再点保存；关闭后商品页与游客页所有优惠行立即隐藏。开关存 `v2_settings`，前台接口直读数据库下发（绕过插件配置 1 小时缓存，保存后下一次请求即生效）。
- **卡片新字段**：`promo`（enabled / strike / text）、`type`（text / color）、`chips`（底部服务链接，默认空 = 不显示）；均进配置白名单，缺省安全。

### 修改
- 商品页与游客页两处优惠行渲染改为「全局开关 与 单卡开关」双条件；未配置开关的历史数据按开启处理，不出现空白行。
- 商品卡片配置保存：后台表单暂不编辑「购买须知」时保留库中已有值，避免被白名单清洗丢弃。

### 验证
- 静态：`node --check server.js` 通过；主题与后台内嵌脚本 `new Function` 解析 0 错误；13 处改动全部命中目标锚点（0 失败），改动前已备份至 `_bak_v114_promo/`；货币守护 `node tools/check-currency.js` 全绿。
- 插件快照已同步：`tools/xboard-patches/KcIntegration/Controllers/PlanCardController.php` 与本源逐行一致（差异仅为本次新增 6 行；Xboard 仓库 `plugins/` 整体被忽略，快照是插件内容的唯一版本化备份）。
- 接口链路核对：游客商品接口 `GET /api/v1/guest/plan/fetch` 确认为 Xboard 原生免登录路由（`GuestRoute.php`），返回在售套餐；卡片配置接口 `GET /plan/kc-cards` 为插件公开路由，新增下发 `promo_row`。
- 字段透传核对：插件侧对卡片配置整包下发、不做字段白名单，因此新增字段只需过 KC 侧白名单（已加）。
- 运行时 E2E（游客浏览渲染、全局开关关闭后优惠行消失）待容器恢复后补跑 —— 见「影响与风险」。

### 影响与风险
- 本次改动尚未部署到运行中的 Xboard 容器：本机 Docker 引擎在改动期间不可用（Desktop 进程已拉起但引擎管道未就绪），**代码已改完并静态校验通过，部署与真机验证待引擎恢复后执行**。
- 游客可看到完整商品价格与权益，属主动开放的营销信息；购买仍需登录，未引入任何用户数据暴露面。
- 优惠行默认开启：运营需确保「划线原价」口径真实可用（历史未配置的商品不会凭空出现原价，仅显示已填文案）。
- 「品牌水印」按产品决策不做；如后续要上需单独立项。

### 下一步
- 容器恢复后：部署主题与插件、跑一遍游客浏览与优惠行开关的实机验证，并回填本节「验证」。
- 待用户安排：$1 真实充值测试与小额真实首单；收银台基准币文案的定价层决策。

---

## v1.13.0 · 2026-10-11 · 客服工作台与全站美元显示守护

**一句话概括**：新增「客服工作台」——客服一次输入（邮箱/用户ID/订单号）即可只读聚合查看用户余额、订单进度（含 KC 实时复核）、充值到账、卡密与售后状态，并附 4 张标准话术卡；同时把「全站金额一律美元（$）显示」落成硬约束（运行时兜底 + KC 后台清理 + 检查脚本 + 提交钩子）；并把「Xboard 容器补丁核查」并入部署/重建流程（缺失自动重打）。

### 新增
- **客服工作台**（Xboard 运营壳 → 客服工作台；页面 `/plugins/kc_integration/support`）：查询框自动识别邮箱/用户ID/订单号；用户全景（余额 $ / 订阅 / 最近订单 / 充值 / 卡密 / 售后 / 补偿）；订单进度（订单 + 卡密 + KC 实时复核 + 建议处理）；话术卡（Session 指引 / 充值 / 卡密 / 内部边界）一键复制。
- **客服查询接口**：`GET /admin/kc/support/user`、`GET /admin/kc/support/order`（严格只读；`['user','admin']` 鉴权；错误只回通用文案；不返回 Session/密钥）。
- `tools/check-currency.js`：货币显示守护（扫描显示面，命中人民币符号/字样即失败；白名单仅限货币兜底替换实现自身）。
- `tools/xboard-patch-check.js`：Xboard 容器补丁核查/重打工具（`--fix`）；部署引擎（ps1/sh）注入流程尾部自动调用。
- `docs/方案/客服工作台与运营查询设计-v1.0.0.md`：场景（S1–S6）、SOP、接口与页面设计、P2/P3 演进方向。

### 修改
- **货币兜底（FEAT-017）升级**：替换范围含全角 `￥`；对所有页面（含游客页/登录页）常开（原仅登录后激活）。
- **KC 后台 `public/admin.html`**：商品卡片配置预览与占位文案 `¥→$`（随容器重建生效）。
- **鉴权模型修订**：运营壳/客服台**页面壳公开**（不含任何业务数据），壳内 JS 从同源管理端 `localStorage` 读取令牌附加请求头（修复「浏览器直开页面 403 无法使用」）；数据接口鉴权不变（`admin/kc/*`）。
- **部署引擎**：注入流程尾部自动执行补丁核查（缺 → 重打 → 复验）；Windows 引擎委托 node 工具实现，且**新增块保持 ASCII**（修复 PowerShell 5.1 读取无 BOM 文件时中文注释吞换行的解析隐患——实测定位）；Linux 引擎同构；顺带修复 Linux 引擎清单行分隔符被 `read` 折叠导致的空字段错位（TAB → 0x1F 单分隔符）。

### 验证
- 客服工作台 E2E（`_support_verify.js`，自注册测试号 + 临时提权、测毕还原）：用户全景 API（订单 `2026101022104201309630610` / 卡密 `KC-UEQQHXST39SBBQG` 正确回显）、订单进度 API（KC 实时复核 `available`）、headless 页面渲染（标题 / 4 张话术卡 / 两次查询渲染全通过）；未登录调数据接口 403。证据：`debug_screenshots/support-1/2/3.png`、`support-notes.txt`。
- 货币：`node tools/check-currency.js` 全绿；`/admin-login` 页面 `has_¥=false`。
- 部署零漂移：主题部署后 256,724 → 257,123 字节、md5 逐字节一致；插件路由 `route:list` 三条在位、探针 403/200 符合预期。
- 引擎：`ps1 list` / `sh list` 实跑通过；`sh bash -n` 通过；`tools/xboard-patch-check.js` 4/4 PASS。
- 映射核对：在售 #1→plus；发卡记录 plus×25；与 KC 支持集（plus/pro_5x/pro_20x）及上游目录一致。

### 影响与风险
- 收银台（BEpusdt 第三方界面）仍显示基准币 `CNY` 文本（汇率换算基准）——改动等于变更实付金额，属定价层决策，已登记待办。
- 客服台依赖管理端登录态（localStorage）：管理端登出后查询将 403（预期行为）。
- 测试痕迹：客服验证测试号 3 个（`qc-support-*`，均未提权保留）；临时脚本 `_support_verify.js` 等在 gitignore 内。

### 下一步
- 用户执行：$1 真实充值测试与小额真实首单（用户已确认暂缓，等其安排）。
- 待拍板：《系统低耦合重整与上线路线》D1–D6、《后台形态选型》；P2/P3（已列待办、暂缓）。

---

## v1.12.0 · 2026-10-10 · 「购买卡密」前台入口（P1）与后台可配开关

**一句话概括**：上线「购买卡密」P1——商品卡新增次级入口，走经典「下单 → USDT 收银台 → 发卡」链路（后端全复用）；入口与文案收口到 Xboard 插件设置（4 个配置项），**保存后立即生效、可随时关闭**；并产出 P2/P3 详细设计稿。

### 新增
- 前台（主题注入）：商品卡次级入口「购买卡密 · 送朋友 / 先买后用 →」（仅代充类目 & 在售态）；确认弹窗（商品信息 / 支付方式 / 余额展示 / 说明文案 / 去支付）→ 自动 `order/save` + `order/checkout` → 新标签打开收银台 → 完成态（打开收银台兜底 + 查看订单）；失败态可重试。
- 后台可配（Xboard → 插件 → KC 代充集成）：`card_buy_enabled`（总开关，可随时关闭）/ `card_buy_label` / `card_buy_hint` / `card_buy_notice`（说明文案，换行或 `||` 分段）。
- 设计文档：`docs/方案/卡密购买模式-前台设计-v1.0.0.md`（P1 已实现说明 + P2/P3 详细设计）。

### 修改
- `/plan/kc-cards` 的 `card_buy` 配置**直读数据库**：绕过 Xboard 插件配置的 1 小时 `Cache::remember`（该缓存不清则保存后 1 小时内不生效，`octane:reload` 亦不清 Laravel cache），后台保存后**下一次请求立即生效**；未改动任何 Xboard 内核（仍守「保命补丁 / 插件 API / 壳层」红线）。
- 插件 `PlanCardController` 增加 `card_buy` 输出；`config.json` 声明 4 个配置项（插件版本 1.0.1 → 1.1.0）；仓库快照 `tools/xboard-patches/KcIntegration/` 同步。

### 验证
- E2E（全程零真实扣款，`_p1_card_buy_e2e.js`）：入口渲染（"购买卡密送朋友 / 先买后用→"）→ 弹窗（USDT (TRC20) 可选）→ 下单（订单 `2026101023100091803551100`，¥15.00）→ checkout 返回收银台 URL → 模拟到账回调（HTTP 200）→ 自动发卡 `KC-8YL6L6HQNB8UKY6`（attempts=1）→ 订单详情页展示卡密。
- 开关（`_p1_switch_shot.js`，整页加载口径）：关闭 → 接口立即 `enabled=false`、刷新后入口消失（截图 `cbbuy-6-off.png`）；恢复 → 立即回来（`cbbuy-8-reon.png`）。**零缓存操作、零重启**。
- 部署零漂移：本地注入源 === 线上 custom_html 逐字节一致（`md5=7321e9049c83086abb750fa9161ca598`，256,724 bytes）；`php -l` 通过。
- 证据：`debug_screenshots/cbbuy-*.png`、`cbbuy-notes.txt`、`cbbuy-switch-notes.txt`。

### 影响与风险
- 卡密为**可转让凭证**：转卖灰产/套利风险需后续限购与风控兜底（P3 设计已含）；当前仅开放单张购买。
- 双入口并存（向导 / 卡密）：入口文案即"分流器"，需观察用户选择与认知成本。
- 测试痕迹：新增测试用户 2 个（`qc-cardbuy-*` / `qc-switch-*`）、测试订单若干、未兑换卡密 2 张；保留供查看。

### 下一步
- 评审《卡密购买模式-前台设计》P2（我的卡密 / 到期提醒 / 分享 / 兑换联动）与 P3（数量 1–10 与批量）设计稿。
- 「上游只读验通」「小额真实首单」待用户批准；$1 真实充值测试待用户执行。

---

## v1.11.3 · 2026-10-10 · 补回 S8 供应商健康摘要并完成履约链路模拟验证

**一句话概括**：补回 10-07 事故中丢失的 KC 侧「供应商健康摘要（S8）」——新增 `supplier-health.js` 状态机、`/api/integration/health` 重新携带 `supplier_health`、启动/周期刷新与历史快照恢复；商城代充商品从「当前代充服务暂不可售」恢复可售；并完成一次**履约链路全链路模拟验证**（真实下单 → 注入模拟到账回调 → 自动发卡 → 订单页取卡密 → 幂等复验），全程 Mock、零真实扣款。

### 新增
- `supplier-health.js`（KC 仓库根目录）：S8 健康摘要状态机 —— `healthy` / `degraded`（上游失败 1 次）/ `soldout`（连续 2 次失败或余额低于安全线）三态 + `restoreSupplierHealth()` 人工恢复；字段与 10-07 版持久化数据兼容（`failure_count` / `last_probe_status` / `last_probe_reason_code` / `manual_override` / `mock`）。
- `server.js`：`/api/integration/health` 恢复输出 `data.supplier_health`；新增启动即刷新 + 每 5 分钟周期刷新（**仅 Mock 模式执行，不产生任何真实上游调用**）；恢复 `supplier_health_history` 快照追加（保留最近 48 条）；新增联调/运维用 `POST /api/integration/health/refresh`（需集成密钥）。
- `tools/test-supplier-health.js`：S8 状态机自测脚本（此前对应模块丢失，随本版本固化）。

### 修复
- 商城唯一在售商品「ChatGPT Plus 一个月」被判「当前代充服务暂不可售」：实测 `/plan/kc-cards` `sellable=false`、`reason=KC 健康状态不可达`——根因是 KC 侧 S8 实现丢失（`supplier_health_state` 停留在 10-07 旧快照，健康接口不再输出 `supplier_health`，商城展示与下单前置双双 fail-closed）。补回后实测 `sellable=true`、`availability=onsale`。

### 验证
- 自测：`node tools/test-supplier-health.js` 全绿（healthy → degraded → soldout → 人工恢复 → 余额过低 全链路断言通过）。
- 履约链路模拟验证：真实注册用户 + 真实订单 `2026101022104201309630610`（¥15）→ 注入与 BEpusdt 到账通知**同款签名**的模拟回调（HTTP 200 `success`）→ 订单转为已完成 → 插件自动发卡（`v2_plugin_kc_cards`：status=issued、卡密 `KC-UEQQHXST39SBBQG`、attempts=1）→ 订单详情页实测展示「卡密 + 去开通 →」→ KC 兑卡页正常打开；截图见 `debug_screenshots/fulfill-*.png`。
- 幂等复验：重复注入同一回调 + 重复调用发卡接口 → 均无二次发卡（`reused=true`，发放记录数不变）。
- 观察（记录不改）：商品卡「立即办理」按 FEAT-014 设计打开「代充开通向导」（登录 ChatGPT → 获取 Session → 选择账号 → 余额支付，四步）；与经典「下单 → USDT 收银台 → 发卡」路径并行存在，本次模拟走经典路径。

### 影响与风险
- `supplier_health` 刷新当前**仅 Mock 模式执行**；真实模式的实体检（读 ZovoCard 套餐/余额）属「上游只读验通」，需用户批准后开启，安全锁未动。
- 测试痕迹：测试用户 `fulfill-1791643879018@example.com`、测试订单 1 笔（¥15 模拟支付）、测试卡密 1 张（未兑换），保留供查看。

### 下一步
- 用户批准后执行「上游只读验通」与「小额真实首单」；真实模式开启 supplier_health 实体检并接入人工恢复入口。
- 用户执行一笔 $1 真实小额充值测试（付款 → 回传 → 余额到账），完成收款链路最终验收。

---

## v1.11.2 · 2026-10-10 · 充值下限调整至 $1 与收款链路验收

**一句话概括**：应要求把充值最低金额从 $2 下调至 $1（前端两处 + 插件服务端一处同步），修复「账户充值」页金额校验与提示文本不一致的反向 Bug；随版本记录本轮收款链路验收结果——真实 TRC20 收款钱包完成绑定、测试单跳转与回调口验证通过、Xboard 支付渠道核查未发现差异；并修复面板下单断点（容器内核补丁重打、复测通过）。

### 修改
- `tools/kc_panel_inject.html` —— 充值面板自由输入下限 `MIN_USD` 2 → 1（$1~$500）。
- `tools/kc_theme_inject.html` —— 「账户充值」页输入框下限 2 → 1、占位提示同步为「1~500」。
- Xboard 侧插件 `KcIntegration/Controllers/TopupController.php`（宿主挂载目录 `D:\tools\Xboard`，不在本仓库）—— `MIN_AMOUNT` 200 → 100（$1），前后端限制对齐。

### 修复
- 「账户充值」页金额校验反向 Bug：原校验区间 `$10~$5000` 与提示文本「2~500」矛盾，导致 $2~$9 输入被误拒、$501~$5000 又与服务端上限冲突；已统一为 `$1~$500`。
- Xboard 容器内核补丁重打：核查发现 1/3/4 号补丁未应用（容器重建丢失；README 要求「重建必重打」）——实测充值面板下单被「该订阅已售罄」拦截（HTTP 400），充值返佣约束与「返利以货交付为前提」同处缺失；已按 `tools/xboard-patches/README.md` 重打（含备份）并复测全链路。

### 验证
- 补丁重打复测：充值面板全链路（注册 → prepare $1 → 原生 save → checkout → 收银台）由 save HTTP 400「已售罄」转为全通（save 200 建单 → 收银台 200；测试单不支付、到期自动过期）；三文件 `php -l` 通过、`octane:reload` 完成、grep 在位（1/2/2），哈希与仓库补丁版一致（PlanService 为原版+脚本补丁）。
- 部署链路：改动前先比对「本地注入源 === 线上 custom_html」逐字节一致（零漂移）；经 `tools/xboard-apply-custom-html.js` 重部署（写配置 / 清缓存 / Octane reload 全绿）后再次逐字节一致（220,886 → 220,884 字符，-2 即改动量）；线上首页实测含 `MIN_USD = 1`、旧「2~500」已消失。
- 接口冒烟（注册测试号 → `POST /user/kc/topup/prepare`）：`$1` → 200 成功（自动新建套餐）；`$0.5` → 422 拒绝；`$2` → 复用既有套餐；`$1` 复测 → 复用同一套餐；`php -l` 语法检查通过。
- 收款链路验收（随版本记录）：TRC20 收款钱包绑定完成并通过地址校验（仿真占位钱包已删除）；按 Xboard 插件同构请求建测试单 2 笔（POST / GET 两种跳转方式），收款地址回显均为真实钱包，`submit.php` 302 → 收银台页面 200；回调口签名校验正确（错签 422 / 正确签名 200）；bepusdt 容器 → Xboard 回调网络连通实测通过。
- 遗留观察（未改动）：核心回调处理器在「订单不存在」分支返回成功响应（疑似上游核心小瑕疵），不影响正常主流程；按不可变约束未修改核心，仅记录。

### 影响与风险
- $1 下限为**测试期松绑**（用于用户小额真实付款测试）；是否长期保留待用户决定，恢复 $2 需同步改三处并重部署。
- Xboard 侧插件文件位于宿主挂载目录，**不在 KC 仓库**；环境重建 / 迁移时需随插件另行携带。
- 本版本含 2 笔未支付测试单（到期自动过期），未发生真实资金往来；集成密钥与安全锁状态未变化。

### 下一步
- 用户执行一笔 $1 真实充值测试（付款 → 回传 → 余额到账），完成收款链路最终验收。
- 待用户确认《系统低耦合重整与上线路线》D1–D6 与《后台形态选型》两份方案稿；「真实链上钱包地址」硬阻塞已解除。

---

## v1.11.1 · 2026-10-10 · 恢复对外集成接口与被回滚吞失的实现

**一句话概括**：用 10-05 找回快照逐段合并回 KC 侧三个文件，恢复 `/api/integration/*` 发卡接口与后台「对外集成 / 商品卡片配置」面板；并审计补回被回滚吞失的 ZovoCard 挂载、卡池跳过、模拟开关、卡密有效期与告警检查等实现。三件验收全绿。

### 修复
- KC 侧 `/api/integration/*`（发卡 / 回查 / 任务状态 / health）与 `/api/admin/integration/*`、`/api/admin/card-config/*` 恢复可用：10-07 恢复时三个文件被回滚成 09-24 旧版（运行实测 404），本次按快照逐段合并（非整体覆盖），`mysql-store.js` 与快照逐字节一致。
- 审计补回（回滚一并吞失）：`server.js` 恢复 `zovocard-client` 适配器挂载（此前错误回退到旧 broker `gpt-api-client`）、ZovoCard 模式跳过本地卡池、套餐映射 `plus/pro_5x/pro_20x`、模拟模式开关与 MOCK 日志、卡密 180 天有效期、未兑卡提醒与卡住任务告警；`mysql-store.js` 恢复 `issueCdkByRef`（含 `INSERT IGNORE` 并发抢占与失败释放占位）、集成配置存取、`getLatestTaskByCdk` 等函数族；后台恢复「对外集成」与「商品卡片配置」面板。
- 保留 10-07 之后新增的业务改动（`/business-admin` 入口与 business 路由挂载）；清理快照内一处重复的卡密有效期校验（无行为差异）。

### 验证
- 三件验收全绿：离线逻辑 13/13；端到端 15/15（幂等复用 / 落库校验 / 401 与 403 鉴权 / 400 入参 / 真实并发 5 路只发 1 张）；真并发竞争 8 路同 tick 只产生 1 张 CDK。详见 `docs/验收/v1.11.1-集成接口恢复验收.md`。
- 重建 app 容器后 `/api/integration/health` 返回 200（修复前实测 404）；本地与容器内三个文件 md5 一致；`node --check` 通过。
- 测试数据（6 张测试卡密、`XB-*` 引用）已清理，集成配置按测前备份还原；未放开安全锁、未调用真实上游。

### 影响与风险
- 集成密钥仍为联调阶段历史测试值（KC 与 Xboard 插件两侧一致），正式收款前建议轮换。
- 逐文件比对范围以找回的 3 个文件为限；其余文件无 10-05 快照可比；上游与安全锁维持现状。

### 下一步
- 待用户确认《系统低耦合重整与上线路线》D1–D6；阶段 1 前置为真实钱包地址（唯一硬阻塞）→ 上游只读验通 → 小额真实首单（均需单独批准）。

## v1.11.0 · 2026-10-08 · Zovo 商品目录映射与 Mock 订单补全

**一句话概括**：按附带的 Zovo OpenAPI 目录契约扩展独立代充商品和订单映射；当前仍只用文档样例目录，商品/订单全程 Mock，不发真实上游请求。

### 新增
- 独立业务后台读取 GPT 套餐目录：支持 Go、Plus、Pro 5x/20x/50x 和六档 Codex 点数；只把 Zovo registry 的 `key` 作为上游套餐引用。
- 商品配置保存上游商品名、套餐键、目录版本、服务费、点数类型及订阅前置要求。面向用户的商品名、售价和成本参考仍由运营维护；GPT 动态报价不得用目录示例值硬编码。
- Mock 订单快照记录上游商品/套餐映射、目录来源版本、服务费和 `client_request_id`（使用本地订单号）；明确 `order_ref=null`、`not_submitted`、`mode=mock`，以供未来接入时对照，不代表存在上游订单。

### 修改
- 新增/更新商品按目录的三项条件失败关闭：套餐列于 registry、`purchasable=true`、对应 `plans[acc_plan_key].enabled=true`；Pro 20x Renewal（绑卡）不作为普通商品。
- Codex 点数按订阅加购展示并标注需已有有效 Plus/Pro。当前 Mock 不会验证目标账号资格；Claude/Grok 不纳入本期 GPT 商品。
- 更新商品保留已有 JSON 配置并以 JSON 类型保存布尔值，避免点数/订阅标记在回读时丢失。
- ZovoCard、支付和真实履约安全锁不变；运行中的 Compose 强制 `ZOVOCARD_MOCK=1`、`REQUIRE_ZOVOCARD_MOCK=1`，目录 UI 会标明当前为文档样例而非实时可售状态。

### 验证
- Zovo 目录、商品校验和两种订单建单映射定向测试通过；全量 Vitest 5 个测试文件、28 项用例通过。
- `business` / `zovocard-client.js` 语法检查及独立后台内嵌 JavaScript 语法检查通过；文档同步闸门待更新后执行。
- Web 生产构建成功；统一重建 `app` / `web` 后，KC runtime、独立后台和前台返回 HTTP 200，未授权目录 API 返回 401，app/web/mysql 均为 healthy。随后补齐后台建单映射一致性，并再次仅重建 `app`。
- 容器环境确认 `ZOVOCARD_MOCK=1`、`REQUIRE_ZOVOCARD_MOCK=1`；容器内目录解析返回 12 项 GPT 文档 fixture。本次未调用 Zovo API、未创建真实上游订单、未触发扣款或写入测试订单。

### 影响与风险
- 当前 UI 和创建商品校验使用附带 OpenAPI 文档整理的本地 Mock fixture；不能证明 Zovo 当前账号已开放或启用了对应套餐。
- Codex 点数目标账号资格须由未来正式履约前置校验；本期订单 Mock 不做资格判定。服务费是上游单笔服务费，不等于商品售价或商品成本。

### 下一步
- 运营人员可在独立后台读取文档 fixture 并按其映射新增 Mock 商品；尚未使用运营账号写入商品或订单。
- 未来启用实时目录、预检和真实上游订单需要另行批准，不能据本次实现打开 Mock 安全锁。

## v1.10.0 · 2026-10-08 · 新旧系统只读对账与汇总导出

**一句话概括**：完成 MIG-016 的只读对账页面/API，按明确映射比较旧 Xboard 与独立业务库中的订单/余额；不回写、不自动同步，MIG-017 切换仍需单独批准。

### 新增
- `business/reconciliation.js` 与后台 `GET /api/admin/business/reconciliation`：对订单和映射账号余额做只读汇总核对，单次查询最多 31 天。
- 运营后台新增“只读对账”菜单与汇总 CSV 导出；导出只含汇总数，不含邮箱、用户编号和订单明细。
- 订单仅按 Xboard `trade_no` 与业务 `external_order_ref` 完全匹配；余额仅比较唯一 Xboard 用户映射与唯一 USD 钱包。缺失/重复映射单列，未匹配订单不直接判丢失。

### 修改
- 查询使用 `START TRANSACTION READ ONLY` 并在结束时回滚，不落对账运行记录、不执行写入、补单、余额修复或自动同步。
- 新旧数据源与表名固定在服务端配置；查询日期受限为最多 31 天，API 沿用现有后台管理员鉴权。
- KC `/admin`、Xboard 旧商城、KC 技术菜单及 ZovoCard Mock 红线不变。

### 验证
- MIG-016 单测覆盖日期范围、只读事务、匹配/缺钱包规则、数据源缺失失败关闭和数据库隔离；Vitest 4 个测试文件、24 项用例全部通过。
- 已在当前 MySQL 表结构上执行真实只读查询，工具输出仅包含成功标志、只读标志和日期范围；没有输出或导出任何用户/订单/余额明细。
- 统一部署成功；KC runtime、业务后台（含只读对账菜单）、独立前台和业务健康返回 HTTP 200；未授权对账 API 返回 HTTP 401。`app`、`web`、`mysql` 均运行健康。
- 运行容器确认 `ZOVOCARD_MOCK=1`、`REQUIRE_ZOVOCARD_MOCK=1`。未执行迁移或创建业务测试记录；app 启动时按既有逻辑重置资产 `in_use` 锁标记。

### 影响与风险
- Xboard 旧订单总量包含范围较广的商城订单，只作背景统计；仅明确关联单号的 USD 订单计入金额比较，USDT 不做汇率换算。
- 余额只覆盖有唯一用户映射与唯一 USD 钱包的用户，不代表全站所有用户资产；差异只供人工核查，工具不会修复。
- 本功能不等于数据迁移或切换。MIG-017、新旧入口切换及任何真实资金/历史数据迁移仍待单独批准。

### 下一步
- 运营人员查看只读汇总并评估映射质量；本轮没有使用真实管理员账号测试 CSV 下载。
- MIG-017 需单独批准；入口切换、灰度或任何历史数据迁移均未执行。

---

## v1.9.0 · 2026-10-08 · 独立代充前台 Mock 闭环与运营收尾

**一句话概括**：在现有 Next.js 页面框架上增量接入用户归属的 Mock 订单与状态展示，补齐运营异常、售后及交易凭证；不启用真实支付、ZovoCard 或履约。

### 新增
- `business/user-auth.js`、`business/storefront-routes.js` —— 前台 Bearer 用户身份临时向 Xboard 校验；提供商品、本人订单、模拟支付/履约和售后 API。
- `web/lib/storefront.ts` 及前台页面 —— 独立商品页、订单状态、售后留言与 Mock 交易凭证；原真实充值/Session 入口明确关闭。
- `web/Dockerfile` 与 Docker Compose `web` 服务 —— 独立前台容器，宿主端口 `3001`。
- 业务后台新增异常队列、售后决定与审计记录；不执行退款或资金变更。

### 修改
- `business/repository.js` 增加用户映射、订单归属隔离和 Mock 状态推进；业务库不保存用户令牌或 ChatGPT Session，不修改 KC/Xboard 旧库和钱包。
- 更新顶栏、帮助、个人资料、页脚与首页文案，避免把仍保留的旧商城/充值/兑换入口误认为新代充闭环。
- R5 低优先级模块完成取舍：不新建卡密库存、不探测真实供应商、不扩展成本/毛利报表。
- KC `/admin`、KC 技术菜单、Xboard 旧商城和原业务路由保留；ZovoCard Mock 环境锁定配置未放宽。

### 验证
- Node 文件语法及后台内嵌脚本语法检查通过；Vitest 3 个文件、17 项用例通过。
- Next.js TypeScript 检查、独立前台生产构建、Docker Compose 配置检查通过。
- 统一部署成功；KC runtime、业务后台、KC 登录页、独立前台、业务健康及商品读取均返回 HTTP 200，未登录订单接口返回 HTTP 401；`app`、`web`、`mysql` 均健康/运行中。
- 运行容器确认 `ZOVOCARD_MOCK=1`、`REQUIRE_ZOVOCARD_MOCK=1`。未执行迁移，未创建测试订单、售后、充值或账务数据；app 按既有启动逻辑重置了资产 `in_use` 锁标记。
- 未使用用户/管理员凭据完成交互验收；无真实支付、退款或上游调用。

### 影响与风险
- 独立前台 `http://localhost:3001` 与业务后台 `http://localhost:3100/business-admin` 仅适用于部署主机本机访问；远程运营需另配可访问域名。
- 用户身份依赖 Xboard API 临时校验；认证服务不可用时订单操作失败关闭。Xboard 登录令牌沿用前台现有浏览器登录机制，业务库不保存该令牌。
- Mock 状态只表示演练结果，不能作为真实收款、余额到账或服务开通证明；打印凭证不是发票或付款凭证。

### 下一步
- 由运营人员使用现有账号自行验收登录、商品配置和用户 Mock 流程；真实支付、真实履约、生产钱包和旧数据迁移继续关闭。

---

## v1.8.0 · 2026-10-08 · 独立代充后台 R0–R2 本机部署（保持 Mock）

**一句话概括**：为运营人员恢复独立的代充业务后台最小闭环，覆盖商品、模拟订单、USDT 随机识别和余额异常补记；不连接真实钱包或 ZovoCard。

### 新增
- `business/validation.js`、`business/repository.js`、`business/admin-routes.js` —— 业务入参校验、现存业务表访问、管理员业务 API；账号邮箱只保存脱敏值和 HMAC 指纹。
- `business-infra/business-db.js` —— 连接独立 `kc_business`，验证已应用 `0001/0002` 迁移校验值；不创建表、不自动迁移。
- `public/business-admin.html` 与 `/business-admin` —— 独立运营控制台：工作台、代充商品、订单、Mock USDT 充值核验/补记、业务钱包和流水。
- 充值补记仅接受 `mock_usdt` 记录及 `MOCK-` 凭证；金额不匹配进入人工核验，精确匹配后在事务中更新 Mock 钱包、追加幂等流水并写审计。
- Docker Compose 固定设置 `ZOVOCARD_MOCK=1` 与 `REQUIRE_ZOVOCARD_MOCK=1`。

### 修改
- `server.js` 挂载独立后台页面和业务 API，复用现有管理员鉴权；KC 技术后台菜单保持不变。
- `public/admin-login.html` 与 `public/business-admin.html` 支持从业务后台发起登录后返回原业务入口；只接受站内固定 `/business-admin` 路径，避免开放重定向。
- Xboard 的 `resources/views/admin.blade.php` 仅将“代充运营”菜单链接改为 `http://localhost:3100/business-admin` 并新标签页打开；修改前已备份并校验 SHA256，未删除 Xboard 路由或菜单规则。
- `tools/verify-business-backend.js` 改为只读验收，只调用 GET，需显式传入已有管理员令牌，不再自动造商品、订单或账务数据。
- 产品全景、项目状态和本计划更新为真实交付状态：R0 已只读完成，R1/R2 已本机部署。

### 验证
- 新增/修改 Node 文件语法检查通过；管理页面内联脚本语法检查通过。
- `docker compose config --quiet` 通过；KC app 重建成功并健康运行。
- `/business-admin` 返回 HTTP 200；未授权业务 API 返回 HTTP 401；管理员路径 API 确认登录 `/admin-login`、技术后台 `/admin` 未改变。
- Xboard 管理页返回 HTTP 200 且含新菜单链接；`php artisan optimize:clear` 与 `octane:reload` 成功。
- 容器内 `ZOVOCARD_MOCK=1`、`REQUIRE_ZOVOCARD_MOCK=1`。
- Vitest：2 个测试文件、13 项用例全部通过。
- 使用现存业务库进行只读 HTTP 核验：健康、汇总、商品、订单、充值、钱包、流水端点均成功；没有调用任何写接口。
- 已核实 `kc_business` 与 KC/Xboard 库隔离，`0001/0002` 校验值匹配；运行库迁移和数据写入均为 0。
- `node tools/check-docs-sync.js`：15 项通过，0 警告、0 失败。

### 影响与风险
- 只部署到当前本机环境；`localhost` 地址适用于运营人员在同一台机器访问。若运营人员使用其他设备，需改成服务器可访问的域名/地址。
- 没有使用真实管理员凭据完成登录，也未向运行库写入 Mock 演练数据；R2 写操作仍需在受控环境验收。
- USDT 随机尾数、充值核验与补记均是独立业务库 Mock 演练，不接链、不收款、不修改 KC/Xboard 余额。

### 下一步
- 运营人员使用现有管理员邮箱/密码登录并验收控制台；如启用二次验证，沿用现有设置。
- 然后进入 R3，在现有前台框架内增量接入商品、模拟下单和状态查询。
- 真实支付、真实履约和生产钱包继续保持关闭，未经单独批准不得开启。

---

## v1.7.1 · 2026-10-07 · 仓库恢复与 git 安全护栏：git-safe 拦截危险命令 + 快照留底

### 背景（事故）
验证 pre-commit 钩子时误用 `git stash` 做快照，stash pop 中断导致 `.git/refs` 与 pack 文件损坏，git 命令全部失效（报 `not a git repository`）。最终通过「备份 .git → 重建 refs 结构 → `git init` 重建仓库 → 用工作区重新提交」恢复可用。原始提交历史（pack 对象）已丢失，故本次为重建提交，内容以工作区为准。

### 新增安全护栏
- `tools/git-safe.js` —— ① `check` 预检危险命令（`reset --hard` / `clean -fd` / `checkout -f` / `branch -D` / `push --force`）并拦截（退出码 2）；② `snapshot` 用 `git hash-object -w` 把内容写入对象库、**完全不碰工作区**（吸取 stash 中断教训，不依赖 stash 引用）；③ `scan` 盘点无备份资产
- `.githooks/pre-push` —— 推送前跑 `git-safe.js scan`，提醒存在无备份资产（不阻断，仅警告）
- `.gitignore` 加固 —— 排除 `_d4prof*` / `_d4prof_b` / Chrome profile（含 `.dmp`）/ 一次性调试脚本与 txt / `.git_broken_backup` / 根级 `_*.txt` 临时文件

### 验证
- 内容完整性：用原始提交 183 个 blob 基准逐项比对，174 个 ASCII 文件名文件**字节级完全一致**，无乱码、无截断
- `git status` 恢复可用，分支 `main`，`core.hooksPath=.githooks` 已设
- `node tools/check-docs-sync.js` 15 项全过（提交前闸门通过）
- 安全脚本 `check` 对 `reset --hard` 返回退出码 2 拦截；`snapshot` 不改动工作区文件（已验证）

### 影响与风险（真实损失，已核实）
此前"business/domain/fulfillment/business-infra 四个目录永久丢失"为损坏仓库状态下的**误报**。实际磁盘状态：
- **已恢复（此前误报为丢失）**：`business/`、`business-infra/`、`public/business-admin.html`、`test/business-validation.test.js`、`docs/归档/`
- **确实丢失（从未提交、git 无记录、无法恢复）**：`domain/`（七态领域模型与状态机）、`fulfillment/`（KC 履约适配层）、`public/business.html`、`接口api.md`
- 缺失目录需照 `docs/设计/ARC-001 代充领域模型与状态机.md` 与 `docs/计划/代充独立后台开发计划-v1.0.0.md` 重建

### 下一步
- 重建 `domain/`（七态状态机）与 `fulfillment/`（履约适配层），完成后先 `node tools/git-safe.js snapshot` 留底再提交
- 任何未提交的新目录改动前，先 `node tools/git-safe.js snapshot "说明"`
- 严禁在真实工作区跑 `git reset --hard` / `git stash` 做测试；测试一律用临时副本目录

---

## v1.7.0 · 2026-10-07 · 文档同步自动闸门：漏更新产品全景将被拦截提交

**一句话概括**：新增 `tools/check-docs-sync.js` 与 git pre-commit 钩子——改了功能却忘了更新产品全景时，**提交会被直接拦下**，不再依赖自觉。

### 新增
- `tools/check-docs-sync.js` —— 文档同步自检脚本，15 项检查分三组：
  - **版本一致**：`VERSION.json` / `CHANGELOG.md` 顶部 / `README.md` 三处版本号必须相同
  - **产品全景滞后检测**：全景标注的「对应版本」不得落后于当前版本，落后即判定「新增功能很可能未同步」
  - **结构性完整性**：六个核心章节在位、未来规划三档未混、产品红线未被删减、开发规范六步流程连续且保留「同步产品全景」步骤、每个版本条目含验证与下一步、编码无损坏、三个入口文件均引用产品全景
  - 支持 `--json` 输出，供 CI 消费；退出码 0/1 可直接接钩子
- `.githooks/pre-commit` —— 提交前硬拦截，失败时打印补全顺序与规范指引；已执行 `git config core.hooksPath .githooks` 启用。
- `package.json` 新增 `docs:check` / `docs:check:json` 两个脚本，并把 `pretest` 接到自检——**跑测试前先过文档闸门**。
- `docs/产品全景.md` 顶部加机器校验锚点，功能表格行加 `<!-- feat:xxx -->` 标记，便于按功能追溯滞后范围。

### 修改
- `docs/开发规范.md` —— 第 7 节新增「文档同步闸门」：提交前必须跑 `node tools/check-docs-sync.js`，并说明紧急情况可用 `git commit --no-verify`。
- `docs/产品全景.md` 第七节维护规则补一条：**提交前跑自检**，确保全文与代码同步。

### 验证
- 正常态：15 项检查全过，退出码 0。
- **故障注入验证（关键）**：人为把全景版本改成 `v1.5.0` 并删改章节标题，自检准确报出 2 项 FAIL（`产品全景未落后于当前版本`、`产品全景核心章节完整`），退出码 1，并给出补全顺序。验证后文件完整还原，无残留。
- 确认 `node` 在 Git 自带 sh 中可解析（`command -v node` 返回 managed node 路径），钩子不会因找不到解释器而失效。

### 影响与风险
- 仅新增校验脚本与钩子，**不改动任何业务代码**，无需重建容器。
- ⚠️ **本轮发生事故**：验证钩子时误用 HEAD is now at fb4da76 merge: preserve remote repository history，导致 、、、 四个从未提交过的业务目录及 、 **永久丢失**（git 历史无记录，无法恢复）。、一键部署脚本、memory 文件已重建并验证。教训：绝不在有未提交新目录的工作区跑破坏性 git 命令；重要工作应先提交或建分支。
- ⚠️ 首次启用钩子后，若存在历史遗留的文档不一致，提交会被拦下；按提示补全或用 `--no-verify` 临时跳过。

### 下一步
- 后续每次功能迭代，提交前跑 `node tools/check-docs-sync.js`；新增功能时在产品全景对应行加 `<!-- feat:xxx -->` 标记。

---

## v1.6.1 · 2026-10-07 · 产品全景文档：产品需求唯一正本

**一句话概括**：新增一份用业务语言写的《产品全景》，集中回答"系统现在有什么功能、用户怎么用、未来做什么"——此前 43 份文档里没有任何一份能回答，换模型只能靠猜。

### 新增
- `docs/产品全景.md` —— **产品能力与边界的唯一正本**。七节：①系统是什么（四个组成部分及各自可见性）②核心业务流程（主流程/用户状态/余额充值/售后，全部业务语言）③现有功能清单（按普通用户/运营/业务后台/内部技术四类角色组织）④**明确不做什么**（发票、分销提现、KC 菜单迁移等，防误判）⑤**未来规划三档**（待做/明确不做/远期只记录）⑥不可跨越的红线 ⑦文档维护规则与"我想知道X看哪个文件"索引。
- `VERSION.json` 新增 `reading_order`（机器可读阅读顺序）、`doc_authority`（文档权威归属）、`product_scope`（产品定位/组成/核心原则/三档规划）。

### 修改
- `README.md` 开发协作入口阅读顺序扩容为 6 步，**`docs/产品全景.md` 排第 2 位**（先知道产品是什么，再看改了什么）；并写明两条权威约定：产品全景是正本、CHANGELOG 最新在顶部。
- `docs/开发规范.md` —— 迭代流程从五步扩为**六步**，新增「③ 同步产品全景（涉及功能时必做）」；明确"只改代码不改全景 = 未完成"；自检清单加一条全景同步检查。
- `docs/00_项目状态.md` —— 阅读指引加入产品全景，并声明本文件**不再维护产品功能与业务流程**，避免与产品全景重复。

### 验证
- 16 项校验全过：两 JSON 合法；README 含产品全景入口与阅读顺序；四个文件编码 0 乱码；开发规范六步流程编号连续无重复（修复了插入新步骤时暴露的 ④⑤ 重号）。
- 已交叉核对 `docs/设计/代充独立后台产品方案基线-v1.0.0.md` 与远期规划，确认功能项与规划档位无遗漏。

### 影响与风险
- 仅文档，无代码改动，无需重建容器。
- 产品全景是**汇总视图**，详细设计仍以 `docs/设计/` 对应 FEAT 文档为准；冲突时以产品全景为准。

### 下一步
- 后续每次涉及用户可感知能力的迭代，必须同步产品全景（已写入开发规范强制流程）。

---

## v1.6.0 · 2026-10-07 · 跨平台一键部署脚本与服务清单单一可信源

**一句话概括**：Windows 和 Linux 都能双击一键启动/停止/更新部署，服务清单只写一个文件，新增服务两套脚本自动跟随。

### 新增
- `deploy-manifest.json` —— **服务清单唯一可信源**。集中列出 kc / xboard / bepusdt 三个服务的类型、compose 路径、project、容器名、端口、健康检查地址、后台地址、是否需要注入前端。脚本和说明都读它。
- `kc-deploy_20261007.ps1`（Windows 引擎）+ `kc-deploy_20261007.sh`（Linux/macOS 引擎）—— 都改为清单驱动，`start`/`stop`/`deploy`/`status` 按清单遍历，不再硬编码服务名。
- 新增 `verify` 动作 —— 对比「清单期望的容器集合」与「实际运行的容器」，缺失/多余都逐条告警，用于发现漂移。
- 新增 `list` 动作 —— 直接打印当前服务清单（不需要 Docker）。
- 启动器：`start_/stop_/deploy_/console_20261007.{bat,sh}`。文件名全英文，去掉了原来的中文和 emoji。
- `DEPLOY_GUIDE.md` —— 安装部署说明。

### 修改
- `docker-compose.yml` —— app 服务补挂 `business`/`domain`/`business-infra`/`fulfillment` 四个目录，修复 recreate 崩溃。
- `README.md` —— 顶部新增「开发协作入口」段，作为任何模型的开场读入点。
- `docs/00_项目状态.md` —— 一键启停说明改为英文跨平台文件名。

### 修复
- `.bat` 双击报 `'hell' 不是内部或外部命令` —— 根因是文件为 UTF-8 + LF 换行，cmd 解析错位。已改为 GBK(936) 编码 + CRLF 换行重写全部 4 个 `.bat`。
- PowerShell 脚本 `$args` 与内置参数冲突的 BUG。
- bash 的 `show_status`/`verify_deploy` 在管道 `while` 子 shell 里累积数组，变量会丢失（会导致 status 列出全部容器、verify 比对空集合），已改用进程替换 `< <(...)`。
- `set -u` 下引用可选的 `$XBOARD_DIR` 会中止脚本，已加 `${XBOARD_DIR:-}` 兜底。

### 验证
- `deploy-manifest.json` JSON 解析通过，3 个服务解析正确。
- PowerShell 引擎经 `Parser::ParseFile` 语法检查 **PARSE_OK**。
- bash 引擎经 `bash -n` 语法检查 **BASH_SYNTAX_OK**（含修复后复检）。
- 清单→TSV 提取逻辑用 node 与 python3 双引擎实测，输出字段完全一致。

### 影响与风险
- 需要重建 app 容器；不触碰业务数据。
- Linux 引擎依赖 JSON 解析器（jq / python3 / node 任一），三者都没有时脚本会明确报错。

### 下一步
- 真实生产端到端首单验证（先只读验通，再放小额单）。

---

## v1.5.0 · 2026-10-07 · 独立代充业务后台首版纵向切片

**一句话概括**：新增完全独立的业务后台与前台（`/business-admin`、`/business`、`/recharge`），业务数据写入独立库，不碰 KC/Xboard 原表。

### 新增
- `ARC-001` 领域模型：七态履约状态机与数据所有权边界。
- `ARC-002` 履约契约适配层 `fulfillment/kc-fulfillment-adapter.js`（发卡、回查、启动、状态、健康、幂等重试、错误映射）。
- `SEC-003` 安全护栏：Mock 锁、`FULFILLMENT_LIVE` 安全门、Session/Token 零持久化策略、RBAC 矩阵。
- `DATA-003` 独立业务库 `kc_business`，业务表统一 `biz_` 前缀，含 0001/0002 迁移。
- `ADM-004`～`FIN-011`：商品目录、订单聚合、USDT 随机码、Mock 支付/履约、独立钱包与不可变流水、补偿/售后、Mock 对账、交易凭证。
- `CDK-012`/`SUP-013`/`COST-014`：CDK 指纹库存、供应商 Mock 健康、成本估算。
- `WEB-015` 独立前台首版：`/business`、`/recharge` 与 `/api/public/business`。
- `MIG-016` 只读影子边界 + 脱敏旧系统 ID 映射。

### 修改
- 统一后台 Hub 增加业务后台卡片；**KC 技术后台菜单保持原样未动**。

### 验证
- 全量 Vitest 10 files / 50 tests 通过；`tools/verify-business-backend.js` 真实 HTTP 闭环验收通过。

### 影响与风险
- 独立库已应用迁移，但**未迁移旧订单/余额数据**，未修改 KC/Xboard 原表。
- 真实支付、链上扫描、履约、对外上游 API **全部保持关闭**。

### 下一步
- WEB-015 完整支付/履约切片；MIG-016 灰度验证（仍关闭）。

---

## v1.4.0 · 2026-10-06 · FEAT-018 安全与履约基线（S0～S13）

**一句话概括**：把代充的安全、幂等、补偿、账务、风控、供应商健康、售后、对账一条线全部做实。

### 新增
- **S0** MOCK 安全锁（`REQUIRE_ZOVOCARD_MOCK=1`）、**S1** 统一后台入口 `/admin-hub`。
- **S2** Session 零持久化：只记录脱敏账户摘要，`session_payload` 新任务强制 NULL，续费必须重新粘贴。
- **S3** 幂等、**S4** 失败补偿台账、**S5** 七态统一履约状态、**S6** 带 `event_key` 的不可变账务流水。
- **S7** 风控（IP/用户/CDK/账号指纹 → allow/challenge/block/manual，只存 HMAC 指纹）。
- **S8** 供应商健康与可售状态，**fail-closed**。
- **S9** 订单售后主流程，**S10** 静态帮助中心，**S11** 商品四态可售策略。
- **S12** CDK 生命周期状态统一，**S13** 跨库只读对账与 CSV 导出。

### 修复
- 并发抢占用 `INSERT IGNORE`（ODKU 在 mysql2 下冲突时 affectedRows 仍返 1，会超发）。

### 验证
- 各段独立验收通过（Vitest、typecheck、Next build、PHP lint、Octane reload、HTTP 实测）；MOCK 锁全程保持 true，未调用真实 ZovoCard。

### 影响与风险
- 对账只读，不自动纠账、不批量改账、不执行退款。
- 历史 Session 仅隔离统计，不在本段删除。

### 下一步
- 独立后台开发计划 `DP-2026-10-07-v1.0.0`（见 v1.5.0）。

---

## v1.3.0 · 2026-10-02 ～ 10-05 · 前台体验重做与「防中间态」体系

**一句话概括**：前台商城改版（顶栏/门户/商品/订单），并沉淀出一套「不让原生界面闪一下」的注入式改造方法论。

### 新增
- `FEAT-006` 商品卡片改版、`FEAT-007` 统一压制中间态、`FEAT-008` 登录跳转中间态。
- `FEAT-009` 服务分类与商品页 FAQ、`FEAT-010` 代充向导、`FEAT-011`/`012` 向导可勾选列表与统计行。
- `FEAT-013` 向导状态不落盘（每次打开商品即重置，删掉 sessionStorage 持久化）。
- `FEAT-014`～`016`：登录闪现三轮修复（最终定位到「`booted` 只代表脚本跑完、不代表目标页就绪」）。
- R1/R2/R3 首页改版与游客落地页。

### 修改
- 前台改为**美元计价**（Xboard 全站无货币字段，金额是「分」裸数字、币种靠前端硬编码，改币种属显示层+定价数据改动）。

### 修复
- 代充进度读错字段（接口返回 `task_status`，旧代码读 `status`）—— 导致购买向导**永远判定不了完成**。
- StrictMode 下 ref 未重置导致轮询立即放弃。
- 充值套餐并发创建脏数据膨胀。

### 验证
- 各段 UI 验收 8/8～24/27、DOM 与像素级录制、真实登录流程 CDP 验收。

### 影响与风险
- 前台自建（Next.js+TS+Tailwind，`web/`），Xboard 后端/KC 引擎/数据库一行不改，旧前台保留可回退。
- 业务决策：**充值不产生返利**，返利以「货交付」为前提，卡密保持非实名改为风险告知。

### 下一步
- 独立代充后台规划。

---

## v1.2.0 · 2026-09-25 ～ 09-26 · 充值分销闭环与前台改版

**一句话概括**：打通「用户自助充值」和「三级分销返佣」两条闭环，并完成前台第一轮改版。

### 新增
- `FEAT-004` D1～D3 兑卡面板 + 充值闭环 + 前台一体化；D4 USDT 渠道（Epay → BEpusdt）模拟全链路打通。
- `FEAT-005` S1 顶部导航框架、S2 四页样式重排、S3 全页走查。
- `FEAT-002` 段C7：Xboard 原生三级分销端到端 13/13（**零开发**，靠原生机制 + 充值短路兼容）。

### 修改
- 充值主路径挂 `payment.notify.verified`，**原生履约完全短路**（订阅字段零覆写）；弃用 `order.open.before`（该钩子在事务内且不检查返回值，不能用于拦截）。
- 充值套餐改为同金额一律复用，删除「未支付订单占用」约束。

### 修复
- BEpusdt 地址分层：`config.url=127.0.0.1:8080`（浏览器收银台）+ `notify_domain=172.17.0.1:7001`（容器回调）。

### 验证
- D2 主路径 27 断言、防套利 6、HTTP E2E 14、浏览器 10；C7 端到端 13/13；S1/S2/S3 = 31/36/55 断言。

### 影响与风险
- **Xboard 容器内补丁重建必重打**（`PlanService.validatePlanAvailability` 加 kc_is_topup 豁免；`TopupController::prepare` 去掉 `AND p.show=1`）。

### 下一步
- 前台防闪现改造。

---

## v1.1.0 · 2026-09-24 ～ 09-25 · 打通 KC ↔ Xboard 代充闭环

**一句话概括**：从「发卡」到「用户开通」的全链路打通，前台商城 Xboard 部署上线。

### 新增
- `FEAT-002` 段C1：KC 侧 `POST /api/integration/cdk/issue`（以商城订单号为幂等键）+ 后台集成面板。
- 段C2：Xboard 发卡插件 `KcIntegration`，挂 `order.open.after` 自动申领卡密。
- 段C3：**「付款→发卡→兑卡→开通」闭环打通**。
- 段C4：状态回传（走 Xboard 插件代理，因 **KC 无 CORS 配置**，前台无法跨域直连 `:3100`）。
- 段C5：真实进度与失败原因（新增 `/api/integration/task/status`，失败原因脱敏 + 截断 120 字）。
- `FEAT-003` 段A 礼品卡余额闭环、段B BEpusdt USDT 收单网关部署。

### 修复
- **并发超发**：`ON DUPLICATE KEY UPDATE` 冲突时 affectedRows 仍返 1，导致 8 并发产出 8 张卡 —— 改用 `INSERT IGNORE` 后只产 1 张。

### 验证
- 段C1 离线 13/13 + 端到端 15/15 + 真并发 8 路只发 1 张；段C2 10/10；段C3 10/10；段C4 14/14；段C5 全过。

### 影响与风险
- Xboard 选型确认（zfaka 功能过简弃用），库 `xboard` 复用 KC 的 MySQL 实例。
- 唯一阻塞：**缺真实链上钱包地址**，BEpusdt 为非托管，钱必须进用户自己的钱包。

### 下一步
- 充值与分销闭环。

---

## v1.0.0 · 2026-09-24 · 项目基线：代充引擎 + Docker 化

**一句话概括**：项目起点 —— Node.js + Playwright + MySQL 代充引擎，Docker 化部署，接入 ZovoCard 第三方代充 OpenAPI 并支持 MOCK 模拟。

### 新增
- KC 代充引擎主体：`server.js` / `product_activator.js` / `mysql-store.js` 等。
- `zovocard-client.js` —— ZovoCard 客户端，与旧 `gpt-api-client.js` **同名接口**，`server.js` 仅切 require，worker 逻辑零改动。
- **MOCK 模拟开关** —— 用 client 短路实现，模拟全流程但不真实扣费。
- 用户前台 + 管理后台（卡池、CDK、任务、账单、系统配置、运行日志）。
- Docker Compose 部署（app + mysql）。

### 修改
- 套餐映射改为 `plus` / `pro_5x` / `pro_20x`；ZovoCard 模式**跳过本地银行卡池**。
- 出网固定走 SOCKS5 代理，出口 IP `216.223.16.210`（已加入 ZovoCard key 白名单）。

### 验证
- 后台「测试连接」通过；MOCK 端到端代充实跑成功（未真实扣费）。

### 影响与风险
- **生产 key = 真实资金**：首单务必小额，先只读验通再放单。
- **白名单 IP 依赖代理不变**：换代理必须同步更新白名单。

### 下一步
- 与前台商城对接。

---

# 历史说明

- v1.0.0 ～ v1.5.0 为 **2026-10-07 事后回填整理**，按主题合并了当时的 FEAT / ARC / S0～S13 编号，并非当时的正式发布记录。原始过程记录仍保留在各验收报告和 `docs/00_项目状态.md` 决策表中。
- **从 v1.6.0 起严格按 `docs/开发规范.md` 执行**：每次迭代顶部追加、含验证记录与下一步、只升版本不覆写历史。
- **从 v1.7.0 起文档同步由 `tools/check-docs-sync.js` + git 钩子强制保证**，不依赖自觉。
