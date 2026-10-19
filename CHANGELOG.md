# CHANGELOG · KC-PAY-GPT

> **本文件是版本记录的唯一正本，只追加、不覆写。**
> **最新版本永远在最顶部 —— 读第一个条目即可，不需要搜索。**
> 配套规范见 `docs/开发规范.md`；入口见 `README.md` 顶部「开发协作入口」。

格式：`v主版本.次版本.修订号 · 日期 · 一句话标题`
新增功能升次版本，修 bug 升修订号，架构重写升主版本。

---

## v2.17.1 · 2026-10-18 · 前台弹层生命周期收口：修「购买卡密弹层压住兑换页」+「后开的弹层被先开的盖住」

**一句话概括**：用户报真实缺陷 ——「在**购买卡密**弹层点『**去兑换**』，页面已切到「兑换卡密」，但**购买卡密弹层仍压在最前面**把新页面遮住了」。**根因两条**：① `go(view)` 切换视图时**从不收弹层**；② 全站 `.modal` 的 z-index **同为 100**，同值时按 **DOM 顺序**绘制 —— `#ckModal` 在 DOM 中排在 `#rcModal`/`#authModal` **之后**，所以在 ckModal 里点「去充值」唤起的充值弹层、点登录唤起的登录弹层，都会被 ckModal 反过来盖住。本版把弹层生命周期收口为两条铁律：**① 切页必收全部弹层；② 后开的弹层一定压在前一个之上**。

### 变更

- **弹层生命周期统一（`public/site/index.html`）**：
  - 新增 **`openModal(id)`**：打开弹层前登记 **z-index 堆叠**（无弹层展示时归位 101，否则 +1），保证「后开的弹层」永远压在前一个之上 —— 修复 ckModal 内「去充值 → rcModal 被盖住」「401 → 登录弹层被盖住」两类层级残留。
  - 新增 **`closeAllModals()`**：收掉 8 个业务弹层（help/auth/rc/rcLeave/guide/order/ck/as）并调 `closeRecharge()` 一并停掉充值倒计时与链上轮询；**`go(view)` 首行调用它** —— 修复「弹层里点『去兑换』跳页后遮罩残留」。
  - **例外**：`#fpModal`（强制首改密码闸门）**不参与自动关闭**，避免切页绕过改密；全站弹层展示统一改走 `openModal()`（不再直接 `classList.add('show')`）。
- **同类问题排查结论（全站）**：主站前台 `public/site/index.html` 共 **4 处**（① 购买卡密弹层「去兑换」留下遮罩 ← 用户上报；② **订单详情卡密单「去兑换」** 留下遮罩；③ **购买卡密弹层「去充值」** → 充值弹层被购买弹层盖住；④ **购买卡密弹层会话失效(401)唤起登录** → 登录弹层被盖住）。其余前台 **0 处**：租户白标前台 `public/tenant/index.html`（仅 1 个登录弹层，且 `closeAuth()` 先于 `go()`）、`public/api-portal.html`（弹层内无跳页入口）、旧落地页 `public/index.html`（无弹层）。
- **购买卡密「去充值 → 到账」回流（`public/site/index.html`）**：`confirmRecharge` 到账成功时，若 `#ckModal` 仍展示则调 `ckRefreshBill()` 刷新账单（余额/还差/可购买）—— 使「从购买卡密弹层去充值、到账后关掉充值弹层即可继续购买」闭环（不刷新会残留「余额不足」旧账单）。
- **测试基建补强（`tools/_v2190_modal_layer_verify.js`，新增）**：9 条用例 / 16 项断言（功能 F1~F5 + 体验 U1~U3），含**源码守卫**（除 `fpModal` 外禁止直接 `classList.add('show')` 开弹层；`go()` 首行必须 `closeAllModals()`）与**命中测试**（`document.elementFromPoint` 证明弹层内按钮真能被点到，而非被透明遮罩挡住）。

### 验证

- **验收 `tools/_v2190_modal_layer_verify.js`（Playwright + MySQL）16 PASS / 0 FAIL / 0 SKIP**：**F1 购买卡密弹层「去兑换」→ 切到兑换页且弹层全收**（`modals=[]`，页面上 0 遮罩）；**F2 订单详情「去兑换」→ 切页 + 弹层全收**（并带卡密直入向导、跳过手输步）；**F3 购买卡密弹层「去充值」→ 充值弹层压在最上层**（`rcModal:102 > ckModal:101`）且「生成收款码」按钮**可被命中**；**F4 购买卡密弹层会话失效唤起登录**（401 分支同一路径 `clearSession()+openAuth('login')`）→ 登录弹层在最上层、邮箱框可输入；**F5 源码守卫**（弹层展示统一走 `openModal()` + `go()` 首行 `closeAllModals()`）；**U1 跳页后顶部导航可被命中**（无不可见遮罩）；**U1.2 落点不丢失**；**U2 关掉充值弹层后回到购买卡密弹层**（上下文不丢、仍可继续购买）；**U2.2 购买卡密弹层「去充值」并真的充到账** → 充值弹层自动收起 + **账单同步刷新**（「还差」消失、恢复可购买）；**U3 嵌套弹层不回归**（充值弹层内「看教程」→ 教程压最上层 → 关掉后回到充值弹层）。截图 `logs/v2190-modal-layer/`。脚本自清理（顾客/订单/卡密/流水/充值单）。
- **回归（未回退）**：代充双轨 `tools/_v2170_dual_topup_verify.js` **22 PASS / 0 FAIL / 0 SKIP**（直接代充冻结→核销/解冻、卡密代充 N 卡、幂等 + UX U1~U5）。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 全绿。

### 下一步

- **旧用例的假阳性需一并纠正（本轮只补新脚本）**：`tools/_v2170_dual_topup_verify.js` 第 259 行用 `#ck-done .btn.primary:last-of-type` 点「去兑换」，实际命中的是**「一键复制全部卡密」**（`:last-of-type` 按元素类型判定，同屏两个 primary 按钮时先命中的那个），随后又手工 `closeCdkBuy()` 收场 —— **这正是该缺陷长期漏检的原因**（详见 v2.17.1 排查结论：用例只断言「入口存在」、从不点它，且用「手工收弹层」掩盖了残留）。
- **✅ 规范沉淀（2026-10-19 已落地）**：两条铁律已写入 [`docs/开发规范.md` §5.1「前端弹层生命周期（两条铁律 · v2.17.1 起强制）」](docs/开发规范.md) —— ①**切页必收弹层**（`go(view)` 首行 `closeAllModals()`）②**弹层展示必须走 `openModal(id)`**（禁止直接 `classList.add('show')`），并写清**唯一例外** `#fpModal`、**新增弹层的连带动作**（id 必须进 `AUTO_CLOSE_MODALS`；带倒计时/轮询的弹层要在 `closeAllModals()` 里一并清副作用）、**怎么验证**（跑 `tools/_v2190_modal_layer_verify.js` 的 F5 源码守卫 + 浏览器断言），以及本次漏检的血泪教训；`§9 自检清单` 同步新增一条「动了前台弹层必须跑该脚本」。属纯文档修订（不动代码）故不升版本号。
- **未 git commit**（`git push` 因 No anonymous write access 不可用，勿重试）。

---

## v2.17.0 · 2026-10-18 · 代充双轨：直接代充（冻结→核销/解冻）与卡密代充（即扣→发 N 张卡密凭证）彻底分轨

**一句话概括**：把「代充」拆成**两条互不干扰的业务路径** —— **直接代充**＝顾客输入 Session 下单，平台**先冻结**该单金额，向上游发起开通，**成功才扣款、失败即解冻**；**卡密代充**＝顾客选数量下单，平台**立即扣款并发放 N 张卡密凭证**，订单即刻完成，顾客之后**随时**在「兑换卡密」页输入卡密 + Session 完成开通。**铁律：完全不改 KC 原生 CDK 发放/兑换核心**（`cdk_codes` / `integration_cdk_issue` / `store.issueCdkByRef` / `POST /api/verify-cdk` / `POST /api/run-process` 语义与实现一字未改），改动只落在**自有订单层**。

### 变更

- **数据层（`mysql-store.js`）**：
  - `kc_customers` 加 **`held_cents`**（冻结额，分；`balance_cents` 语义收敛为「**可用**余额」）。容错 ALTER。
  - `kc_customer_wallet_ledger.type` ENUM 扩 **`hold`/`capture`/`release`**（MODIFY，幂等）。
  - `kc_api_orders` 加三列（容错 ALTER）：**`fulfill_mode` ENUM('auto','direct','cdk') 默认 `auto`**（`auto`=历史/对外 API/非代充的即时交付口径，**默认值即历史语义，既有单不受影响**）、**`hold_cents`**（该单当前冻结额，0=无冻结，作幂等闸门）、**`cdk_list_json`**（卡密代充的 N 张卡密数组；`cdk` 列保留=首卡，兼容原生开通引用与既有对账）。
- **后端（`server.js`）**：
  - 新增冻结三件套 helper：**`holdCustomerFunds`**（可用→冻结，余额不足即拒）、**`captureOrderHold`**（冻结转扣款：可用余额在冻结时已离开，故只减冻结额、记 `capture` 流水 change=0）、**`releaseOrderHold`**（冻结退回可用余额 + `release` 流水）。三者均以「**订单状态原子改判 + `hold_cents>0`**」为准入闸门（`affectedRows=0` 直接跳过），绝不重复加减。
  - **新增平行下单核心 `createDirectTopupOrderCore`**（不复用 `createApiOrderCore` —— 后者是「即扣+发卡」）：幂等 → 锁价 60s → 3% 漂移拦截 → **冻结** → 落单 `status='created'` → **内部发 1 张「不展示给顾客」的卡密**驱动原生开通（发卡失败则立即解冻并置 failed）。
  - **新增 `createCdkTopupOrderCore` + `POST /api/tenant/orders/cdk`**：定价与直接线**同源**（复用 `tenantBatchPlan`，含权益分配，保证「账单价=结算价」）→ **立即扣款** → `issueCdkByRef(ourOrderNo#1..#N)` 发 **N 张真实卡密** → 落单 `status='delivered'`、`fulfill_mode='cdk'`、`cdk_list_json`；部分发卡失败则整单退回（`refund` 流水 + 订单 failed）。
  - **两处 worker 终态挂钩子**：本地 worker（`spawnActivationWorker`）与第三方 worker（`runGptApiWorker`）在 `success`/`failed`/异常落点调 **`settleDirectOrderByCdk(cdk, status, msg)`** → `success` 核销 / `failed` 解冻 / `manual`+`maintenance`+进行中**保持冻结**。
  - **周期对账改造（`reconcileFailedActivationsOnce`）**：①**直接代充在途桶**（`fulfill_mode='direct' AND status='created' AND hold_cents>0`）按任务终态核销/解冻，**无任务且账龄 > `ACTIVATION_HOLD_UNSTARTED_TIMEOUT_MS`（默认 30 分钟）→ 超时解冻**（money 不长期挂起）；②已核销却事后失败的单沿用既有 `refundOrderOnActivationFailure`；③**卡密代充（`fulfill_mode='cdk'`）不参与退款对账**（卡密是顾客买到的凭证，兑换失败会回滚为未使用、顾客可重试）。
  - `GET /api/tenant/orders` 增加下发 **`fulfill_mode` / `hold_cents` / `cdk_list`**；`GET /api/tenant/wallet` 增加下发 **`held` / `held_cents`**。
- **前台（`public/site/index.html`）**：
  - **详情页（代充品类）二选一**：新增 `#d-mode` 两张并列入口卡 —— **⚡ 直接代充**（输入 Session，说明「下单先冻结、开通成功才扣款、失败自动解冻」）/ **🎟️ 购买卡密**（先买凭证，之后随时兑换，可一次买多张）；不再默认直接进呈递向导，**两条流程各自独立**。
  - **购买卡密弹层 `#ckModal`**：选数量（1~100）→ 账单（单价/权益抵扣/应付总额/当前余额，余额不足内联「去充值」）→ 下单 → **展示 N 张卡密凭证**（逐张复制 + 一键复制全部 + 「去兑换」）。
  - **订单中心按 `fulfill_mode` 分支**：direct＝「已冻结·处理中 / 开通中（已冻结） / 已开通·已扣款 / 失败（已解冻）」，时间线改为「已下单 → 金额已冻结 / 已扣款 → 已提交开通 → 开通完成」；cdk＝详情展示 **卡密凭证列表**（N 张 + 去兑换），时间线「卡密已发放 → 待兑换」；auto 口径不变。
  - **钱包**：新增「冻结中」区块（有冻结才出现）；流水类型标签扩 `冻结/扣款/解冻`。

### 验证

- **验收 `tools/_v2170_dual_topup_verify.js`（Playwright + MySQL）22 PASS / 0 FAIL / 0 SKIP**：**F1 直接代充下单＝冻结**（返回 `status=created` + 内部卡密；DB `fulfill_mode=direct`/`hold_cents=amount`；可用余额 `$200→$185`、冻结额 `0→$15`；流水 `hold`）；**F2 上游成功＝核销**（真跑 `POST /api/run-process` 到 `success`；订单 `delivered`、`hold_cents=0`、冻结归零、**可用余额不再变化**、流水 `capture`）；**F3 上游失败＝解冻**（构造 `failed` 任务 + 账龄 15 分钟，经启动首轮对账：订单 `failed`、冻结归零、**可用余额回补 +$15**、流水 `release(+amount)`）；**F4 卡密代充**（一次发 **N=2** 张、回溯 `cdk_list_json`、**即扣** $30 且**不产生冻结**、`/api/verify-cdk` 认卡）；**F5 幂等**（同单号重放 `reused=true`、卡密列表一致、余额不再减少）；**UX U1 二选一入口可辨 + 选「直接代充」进向导、U2 卡密弹层账单与 N 张凭证、U3 卡密订单详情凭证列表 +「去兑换」/直接单「已开通·已扣款」+ 时间线、U4 钱包流水含冻结/扣款/解冻、U5 全程 0 业务 console error**。截图 `logs/v2170-dual/`。脚本自清理（顾客/订单/卡密/流水/充值单）。
- **回归（全绿）**：批量代充 `tools/_v2160_batch_topup_verify.js` **40 PASS / 0 FAIL / 0 SKIP**（已按新流程在详情页点「直接代充」后进向导；F5.5 仍证明「账单展示价=结算价」）；向导+匿名兑换 `tools/_v2150_wizard_verify.js` **19 PASS / 0 FAIL**（B3 已按新口径 `已开通 · 已扣款`）；订单中心 `tools/_v2163_order_activation_verify.js` **20 PASS / 0 FAIL**（auto 口径未回退）；版式 `tools/_v2161_detail_layout_verify.js` **21 PASS / 0 FAIL**；功能套件 `tools/check-functional-suite.js` **50 PASS / 0 FAIL**；`node --check server.js / mysql-store.js` 通过。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 全绿。
- **数据核对**：新列已落库（`kc_api_orders.fulfill_mode/hold_cents/cdk_list_json`、`kc_customers.held_cents`、流水 ENUM 含 `hold/capture/release`）。

### 下一步

- **权益扣次时机**：直接线与卡密线目前仍在**下单成功即扣 1 次权益**（沿用既有口径）；若希望「开通成功才扣次、失败退回」，需把 grant/rule 快照落到订单上并在核销/解冻钩子里做退次（另案）。
- **`manual`/`maintenance` 在途冻结**：目前保持冻结待人工，未接客服工单流（处置清单 §三 外链方案可复用）。
- **未 git commit**（`git push` 因 No anonymous write access 不可用，勿重试）。

---

## v2.16.3 · 2026-10-18 · 订单中心「开通状态」校准：流程已走完（账号已开通）不再显示「继续开通」

**一句话概括**：用户报真实缺陷 ——「流程已经结束了，查看订单还显示**继续开通**，点击继续开通就进入到 CDK 兑换流程」。**根因**：KC 订单状态 `delivered` 的真实语义是「**已发放内部卡密**」，**不等于开通成功**（开通是另一条任务链）；而订单详情对代充单**无条件**按 `status==='delivered'` 渲染「继续开通」按钮 —— 于是**批量流程已把 3 个账号都开通成功后**，订单里仍显示「继续开通」，点下去还会把人送进「兑换卡密」向导（该卡密其实已被消费）。本版把**订单状态与开通状态分开表达**：订单接口随单下发该卡密的**最近一次开通任务状态**，前台据此渲染。

### 变更

- **后端（`server.js` · `GET /api/tenant/orders`）**：为每笔订单补三个字段 —— **`activation_status`**（`none` 从未启动 / `running` / `success` / `failed` / `maintenance` / `manual`）、`activation_message`、`activation_at`；取数用**一条 JOIN 查询**（`task_logs` 按 `cdk_code` 取 `MAX(id)` 的最近任务）覆盖全部订单，**不做 N+1**；同时补下发 **`biz_type`**（订单落库口径，让前台判定「是否代充单」不依赖目录是否已加载）。**未改 KC 原生 CDK 发放/兑换链路，未新增表。**
- **前端（`public/site/index.html`）**：
  - **订单详情「开通」列按真实开通状态渲染**（`topupActivationHtml`）：`success` → **「已开通」徽标（不渲染按钮）**；`running` → 「开通中…」；`failed` → 「开通失败（费用已退回）」；`maintenance`/`manual` → 维护中/需人工处理；**只有 `none`（确实没启动过开通，如批量流程里「未启动」的账号）才给「继续开通」按钮**，并附一行「该系统尚未启动开通，可在此手动继续」。
  - **副标题由「订单状态 + 开通状态」合成**：`订单已完成 · 账号已开通` / `· 正在开通中` / `· 开通失败（款项已退回）` / `· 待开通（可手动继续开通）`。
  - **列表页签计数与状态徽标同步归位**：`orderBucket`/`orderPill` 改为按订单对象判定（原 `statusPill(o.status)` 已删除）—— 已开通记「已完成」、开通失败记「失败」、未开通记「处理中」并显示「待开通」徽标。
  - **订单进度时间线**（`timelineHtml`）按开通状态给 3/4 节点：已开通 → 「卡密已发放 → **开通完成**（账号权益已开通到你的 ChatGPT 账号）」；开通中 → 「开通中」；失败 → 「开通失败（含失败原因）→ 退款处理中」；未开通 → 「待开通（可在上方继续开通）」。**删除原误导性文案**「开通结果以订单状态与账号实际权益为准」。
  - **代充单判定改为 `isTopupOrder(o)`**：优先 `biz_type==='topup'`，回落目录分类兜底（历史单兼容）。

### 验证

- **验收 `tools/_v2163_order_activation_verify.js`（Playwright + MySQL）20 PASS / 0 FAIL / 0 SKIP** —— 用**真实三种状态**跑：①真跑开通（`POST /api/run-process` 实测跑到 `success`）；②不建任务（未开通）；③构造一条 `failed` 任务。断言：接口 `activation_status` = success/none/failed 与 `biz_type` 均为 topup、**订单自身 status 仍为 delivered**（证明「订单状态」这一层没被改坏）；列表徽标 = 已完成 / 待开通 / 开通失败，页签计数 `全部3 · 处理中1 · 已完成1 · 失败1`；**已开通单详情 =「已开通」徽标且无「继续开通」按钮**、副标题「订单已完成 · 账号已开通」、时间线末节点「开通完成」；未开通单仍给「继续开通」+「尚未启动开通」说明、时间线末节点「待开通」、**点击仍能进兑换向导（手动补开通路径保留）**；开通失败单 = 「开通失败（费用已退回）」且无按钮、时间线含「退款处理中」；0 业务 console error。截图 `logs/v2163-order/`（含列表页与已开通单详情）。
- **回归**：向导 + 匿名兑换 `tools/_v2150_wizard_verify.js` **19 PASS / 0 FAIL**（B3 断言随新口径同步）；批量代充 `tools/_v2160_batch_topup_verify.js` **40 PASS / 0 FAIL / 0 SKIP**；功能套件 `tools/check-functional-suite.js` **50 PASS / 0 FAIL**（自清理生效）；版式 `tools/_v2161_detail_layout_verify.js` 21 PASS（未受本轮影响）。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 全绿。

### 下一步

- **同一根因的下一处（待做）**：第 ⑤ 步（批量进度）里「未启动」的账号文案已指向「兑换卡密」页；若希望直接在订单页完成补开通（不走兑换页），可把「继续开通」做成**服务端排队补跑**（复用 `/api/run-process` + 订单里的 Session 已不存于服务端，故需要用户重新提供 Session —— 属产品选择）。
- **`manual`/`maintenance` 态**目前只给文案提示，未接客服工单流（原处置清单 §三 的外链方案可复用）。
- **未 git commit**（`git push` 因 No anonymous write access 不可用，勿重试）。

---

## v2.16.2 · 2026-10-18 · 代充呈递向导版式精修：第 ① 步退役伪浏览器大框 + 地址独立成栏 + 标题与价签同行

**一句话概括**：用户第二次反馈「页面还是很丑、布局很不均衡，例如第一步登录 ChatGPT，链接所占用的空间为什么那么大」。**先量化再改**：用 Playwright 量出每一步的实际渲染高度，确认根因是**装饰过度 + 信息密度过低** —— 第 ① 步的伪浏览器大框（`.wiz-browser`）**独占 208px、占整步高度 42%**，却只承载「地址栏 + 一行字 + 一个按钮」；面板顶部还被「标题 / 价签 / 说明」三行（121px）压着。本版按数据把每一步从「沉浸式大组件」改为「紧凑信息块」，**不动单列/两栏骨架**。

### 变更

- **量化（改前实测 · Playwright）**：步骤 ① panel **719px**（向导 495px，其中伪浏览器 208px）；步骤 ② panel 588px（向导 364px，ol 114px）；步骤 ③ panel 589px；面板顶部「标题+价签+说明」固定 **121px**。
- **第 ① 步退役伪浏览器大框（`public/site/index.html`）**：改为 **「一句说明（左） + 主按钮『打开 ChatGPT ↗』（右）同排」** —— 宽度被真正用起来，纵向不留空；保留 🔒 安全提示（amber）与「查看视频教程」入口；文案里仍给出 `chatgpt.com` 站点名（不重复整条 https 地址栏）。整步高度 **495 → 283px（-43%）**、panel **719 → 437px（-39%）**。
- **第 ② 步把地址从 `ol` 里提出来做独立「地址 + 复制地址」栏**（`.wiz-urlbar`）：地址一眼可见、复制按钮就在旁边；指引由 3 条纵列压成 **2 条单行**（去掉重复的「回到本页点下一步」）。ol **114 → 49px**。
- **面板头部：商品名与价签同行**（`.d-head`）：`ChatGPT Plus 一个月  $9.00 ~~$15.00~~ /账号  用 1 次权益 · 省 $6.00` 一行读完（原为标题一行 + 价签一行 + 虚线分隔）；顶部 121 → **84px**。
- **全局收紧间距**：`.wiz` 内边距 `18/16 → 16/14`、`.wiz-top` 下间距 `14 → 12`、`.wiz-p` `12 → 10`、`.wiz-note` `10 → 8`、`.wiz-acts` `12 → 10`、`.wiz-ol li` `8 → 6`；单列面板限宽 `960 → 880px`（把 ~100 字符的长行压回可读行宽）。
- **文案去重**：详情页 `d-hint` 压成一行（不再重复 ①②③④⑤、不再重复「不需要账号密码」）；「支持批量」移到第 ② 步（粘贴前的决策点）。
- **清理**：伪浏览器相关 CSS（`.wiz-browser/.wiz-bbar/.wiz-dot/.wiz-url/.wiz-bbody/.wiz-ai/.wiz-btxt`）与试用中的 `.wiz-ol.cols` 一并删除，不留死代码。

### 验证

- **版式验收 `tools/_v2161_detail_layout_verify.js`（Playwright）21 PASS / 0 FAIL / 0 SKIP**：U3.1 **第 ① 步装饰块计数 = 0**、「说明+按钮」行高 42px（≤70）；U3.2 第 ① 步 panel **437px ≤ 480**（原 719）；F2.3 第 ② 步地址独立成栏（`https://chatgpt.com/api/auth/session` + 复制地址）；F2.4 **2 条指引各占单行（h=21/21）**；U2.2 第 ② 步向导 345px；U1.1 商品名与价签**同一基线同行**（nameY=195 / priceY=198，priceX-nameX=243）；F3.x 价签口径「$9.00 $15.00/账号 用 1 次权益 · 省 $6.00」；F4.1 第 ④ 步账单仍含单价/总额/余额；**非代充仍是两栏**（临时建成品号实测后删除）；0 业务 console error。截图 `logs/v2161-detail-layout/`。
- **回归**：向导 + 匿名兑换 `tools/_v2150_wizard_verify.js` **19 PASS / 0 FAIL**（断言随新 UI 同步：第 ① 步标题/站点入口、第 ② 步 2 条指引）；批量代充 `tools/_v2160_batch_topup_verify.js` **40 PASS / 0 FAIL / 0 SKIP**；功能套件 `tools/check-functional-suite.js` **50 PASS / 0 FAIL**（自清理生效）。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 全绿。

### 下一步

- **改后尺寸（供下次评审对照）**：步骤 ① panel **437**（原 719）· 步骤 ② **498**（原 588）· 步骤 ③ **529**（原 589）；向导 ① 283 / ② 345 / ③ 376。
- **未做（等你定）**：第 ③ 步空态仍偏高（textarea 7 行占 ~150px），可缩到 5 行；第 ⑤ 步「已完成」态只有一行标题 + 表格，可考虑并入一步；移动端（≤768px）未跑自动化截图。
- **未 git commit**（`git push` 因 No anonymous write access 不可用，勿重试）。

---

## v2.16.1 · 2026-10-18 · 代充详情页版式修正：进入呈递向导后收起右栏价格盒 + 列表 CTA 按品类给意图

**一句话概括**：用户反馈「代充商品页应该显示立即购买」「进入购买流程后右侧为什么一直有价格，这个布局非常丑」。复查确认 **v2.16.0 的改动已生效**（向导已展示、`立即购买`/数量已隐藏、批量提示已在），问题出在 **收尾没收干净**：右侧 `.buybox` 在代充场景下只剩「可购买 + 价格 + 小字」，成为一个**与左侧向导重复、大面积留白的半空盒子**；同时列表卡 CTA 写「查看」，与「代充点进去就是购买流程」的意图不匹配。本版把代充详情页收为**单列聚焦版式**（价格并入向导上方价签行），并把列表 CTA 按品类改为**表达意图**的文案。

### 变更

- **代充详情页收为单列聚焦（`public/site/index.html`）**：`openDetail()` 在代充（`category=recharge`）时给 `.detail` 加 `single` 类（`grid-template-columns:1fr`）、隐藏整块右栏 `.buybox` —— 右侧不再残留重复的价格盒；`.detail.single .panel` 限宽 `960px` 居中，向导内容从 ~700px 变为 ~900px，步骤 ③ 的账号清单表更舒展。
- **价格并入向导上方「价签行」（不丢价格，也不出现两个价格入口）**：左侧商品名下方新增 `#d-priceInline`（`.d-priceInline`，虚线分隔），复用**同一个渲染函数 `detailPriceHtml(item, perUnit)`**（右侧购买箱与价签行共用，避免两处口径漂移），代充额外带 `/账号` 单位；有权益时保留既定口径「用 1 次权益 · 省 $X」。非代充商品该行保持隐藏。
- **列表卡 CTA 按品类给意图**：`cardHtml()` 中 **可售的代充商品 → 「立即购买」**（点进去即进入呈递向导，文案与落点一致）；**成品号 / 建站服务 → 「查看」**（先看详情再决定）；缺货商品一律「查看」（避免在缺货品上写「立即购买」）。
- **去掉详情页顶部信息冗余**：`d-hint` 不再重复罗列「① 登录 ChatGPT → ② 获取 Session → …」（下方步骤条已表达流程），也不再重复「不需要账号密码」（第 1 步已有醒目安全提示），只留「Session 去向 / 交付口径 / 批量口径」三条不重复信息。
- **测试数据治理（`tools/check-functional-suite.js`）**：该套件每跑一次都会在**真实货架**留下一个 `功能测试商品 <uid>`（历史已因此清理过 6 行，本轮又见 `xplan_31`）—— 补上**自清理**（跑完按商品名精确删除 `kc_plans` + `kc_listing_cards`，有订单则保留并打印告警），并清理本轮产生的残留行。

### 验证

- **版式验收 `tools/_v2161_detail_layout_verify.js`（Playwright）16 PASS / 0 FAIL / 0 SKIP**：F1.1 代充列表卡 CTA 全为「立即购买」；F1.2 列表无「功能测试商品」污染；F2.1/F2.2 代充详情右栏 `display:none` 且版式收为单列（`grid 列数=1`）；F3.1~F3.3 价签行可见且为「$9.00 $15.00/账号 用 1 次权益 · 省 $6.00」；U1.1 价格与商品名同列（左边缘 x 均为 123、价格在其下方）；U2.1 向导宽度 902px（≥780）；F4.1 走到第 ④ 步账单仍含「单价 / 应付总额 / 当前余额」（价格未随右栏一起丢失）；**U3.1/U3.2 非代充回归**（临时建 `kc_type=account` 商品后实测：仍是两栏、`#d-buybox` 可见、`立即购买` 与数量选择在位、内联价签隐藏、列表 CTA 为「查看」，跑完删除临时商品）；U4 0 业务 console error。截图 `logs/v2161-detail-layout/`。
- **回归**：批量代充 `tools/_v2160_batch_topup_verify.js` **40 PASS / 0 FAIL / 0 SKIP**；向导 + 匿名兑换 `tools/_v2150_wizard_verify.js` **19 PASS / 0 FAIL**（含 C3 匿名兑换实测开通成功）；功能套件 `tools/check-functional-suite.js` **50 PASS / 0 FAIL** 且新增自清理实测生效（`已清理测试商品 xplan_31`）。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 全绿。

### 下一步

- **待用户确认**：列表卡「立即购买」目前仍**先落详情页再进向导**（保持「详情页能看到流程与批量说明」）；若希望点卡片**直接进入向导第 1 步**（跳过详情页），可再调整 —— 两种都合理，取决于是否要让顾客先看到「支持批量 / Session 不落库」的说明。
- **移动端**：`.detail` 在窄屏本就单列（`@media` 已有规则），本轮 `single` 版式与其一致；实机窄屏（≤768px）未跑自动化截图。
- **未 git commit**（`git push` 因 No anonymous write access 不可用，勿重试）。

---

## v2.16.0 · 2026-10-18 · 批量代充：同一个流程既收 1 段也收 N 段 Session → 一张账单 → 逐账号开通

**一句话概括**：用户上传 sukai 的代充流程截图（同一流程中既可粘贴一行 Session、也可粘贴多行，最后按数量生成账单），要求以**交互专家**身份优化我们的代充流程。经确认按「**真批量**」落地：第 ③ 步一个输入框**既收 1 段也收 N 段 Session**，自动切成账号清单（去重 + 无效行指引 + 勾选）；第 ④ 步出一张**按账号数结算的账单**（含权益抵扣行）；第 ⑤ 步**逐账号进度**（已开通 / 失败已退款 / 未启动）。**保留 5 步骨架**与既有导航口径，`兑换卡密` 分支一字未动。

### 变更

- **后端（`server.js`）**：
  - 新增 **`POST /api/tenant/batch/preview`**（`authenticateCustomer`，**无副作用**：不建单、不扣款、不扣次、不锁价）—— 返回 `count / unit_price / entitlement_unit_price / entitlement_uses / total / total_base / entitlement_discount / balance / shortfall(_cents)`。
  - 新增 **`POST /api/tenant/orders/batch`**（`authenticateCustomer`）—— 入参 `{ sku, count, client_order_no_prefix }`；**总额前置校验**（余额 < 应扣合计 → **402 `INSUFFICIENT_BALANCE`**，回 `shortfall`，**整批不建单**）；**幂等键 = `<批次号>_<序号>`**（同批次重放：已建单不计入余额需求、返回 `reused`、不重复扣款扣次）；逐账号复用 **`createApiOrderCore`**（每账号 1 quote + 1 order + `qty=1`），交付后逐条 `entitlementConsume` 扣次；返回 `results[{index, client_order_no, unit_price, entitlement_applied, order_id, cdk, status, error, reused}]` + `total/total_base/entitlement_discount`。
  - **定价单一事实源**：抽出 `tenantBatchPlan()`（预览与下单**共用**），账单单价/权益抵扣/总额与实扣**逐分一致**（守住「展示价 ＝ 结算价」红线）；权益按各 grant 的**剩余可用次数逐个分配**（本地预扣），权益次数 < 账号数时**前 N 个按权益价、其余按原价**，与下单扣次口径同源。
- **口径（关键约束）**：**1 订单 = 1 内部 CDK = 1 次开通**，故「批量」= **每账号一单**（复用 `qty` 只会乘价、不会多发卡）；批量不新增任何表、不改 KC 原生 CDK 发放/兑换链路。
- **前端（`public/site/index.html`）**：
  - **第 ③ 步 → 账号清单工作台**：`textarea#wiz-sess-topup` 支持粘贴 1 段或 N 段；**按大括号配平切分**（`wizSplitBlobs`，字符串内括号不计）→ 兼容「一行一段」与「整段 JSON 跨多行、一次粘多份」；解析结果表 = 账号邮箱 / 目标商品 / 状态（可办理 · 无效 · 重复）/ 说明 + 勾选框 + 行内「×」删除 + 「全选可办理 / 清空选择 / 清空清单」；**同邮箱自动去重**、**一次最多 100 个**、切不出来的内容以「另有 N 行内容无法识别为 Session，已忽略」提示（复用 `wizTokenHint` 的可执行指引，不暴露 `accessToken` 技术措辞）；汇总句「共 N 个账号 · M 个可办理」+「已勾选 N 个账号，将按此数量出账单」。
  - **第 ④ 步 → 确认账单**：充值账号（>3 折叠为「… 等 N 个账号」）/ 账号数量 / 商品 / 单价（权益次数 < 账号数时按「N 个按权益价 $X · 其余 $Y」分别展示）/ **权益抵扣行「用 N 次权益 · 省 $X」** / 应付总额 / 当前余额；**余额不足 → 红框「余额不足，还差 $X」+「立即充值」+ 支付按钮置灰 + 「充值到账后金额会自动刷新，无需重新提交账号」**；余额不足或账单未取到时**每 5s 静默重取**（拿到充足账单即停），到账后差额消失、按钮启用、**清单不丢**。
  - **第 ⑤ 步 → 逐账号进度**：进度条（按已结算账号数推进）+ 汇总「共 N 个 · 已开通 M（· 失败 K · 未启动 U · 下单失败 D）」+ 逐行账号邮箱与状态徽标（排队中 / 启动中 / 开通中 x% / 已开通 / 失败 / 未启动 / 下单失败）；失败账号提示「费用会由系统自动退回余额（周期对账，通常几分钟内到账）」、未启动提示卡密已保留可继续开通、下单失败明确「未扣费」。**严格顺序启动**（服务端并发上限默认 1，`429` 自动退避重试），**部分失败不回滚整批**。
  - **WebSocket 升级为多任务订阅**（`server.js` 的连接改为 `Set<jobKey>`；前端 `rdEnsureSocket`/`wizBatchJobs` 按 `jobKey` 路由到对应账号行）—— 单账号/兑换流程行为不变，批量可在**同一条连接**上看 N 个任务；断线自动重连并重发订阅，另有 60s 心跳式补拉快照兜底。
  - **详情页**：代充商品隐藏「数量」选择器（数量改由清单决定，避免两个数量入口打架）；流程提示补「批量充值：第 ③ 步可只粘贴 1 份，也可一次粘贴多份」；**第 ② 步**补「要给多个账号充值？请每个账号各自登录一次，各取一份 Session」。
  - 新增 `wizNote()`（提示写入 state，重渲染后仍在）；批量相关内联 `onclick` 入口全部显式挂 `window`。

### 验证

- **批量代充验收 `tools/_v2160_batch_topup_verify.js`（Playwright + MySQL）40 PASS / 0 FAIL / 0 SKIP**，按步覆盖：
  - 第 ③ 步：粘 1 段 → 1 个可办理；粘 3 段（多行）→ 3 个可办理且邮箱顺序一致；混入非法行 → 「另有 1 行内容无法识别」提示且无技术措辞；同邮箱重复 → 自动去重（`dup=1`）；行内「×」删除后清单与输入框同步。
  - 第 ④ 步：账单含账号数量/单价/应付总额/当前余额；**注入「剩余 2 次」权益 → 3 个账号时账单为「用 2 次权益 · 省 $12.00」且「2 个按权益价 $9.00 · 其余 $15.00」**，总额 $33.00 与预览一致；余额压到 $0.30 → 还差 $32.70 + 按钮置灰 + **未建单**（订单数仍 0）+「立即充值」可开弹层；余额恢复 → **差额自动消失、按钮启用、清单仍 3 个**；「上一步」返回清单不丢。
  - 第 ⑤ 步：只发 1 次 `POST /api/tenant/orders/batch` 即进入逐账号进度；**DB 实存 3 单、每单恰好 1 个唯一 CDK**；3 个账号全部「已开通」；**实扣 $33.00 == 预览 total**（展示价=结算价）；权益 grant 剩余 2 次被扣完（`exhausted`，使用记录 2 条）；**同批次号重放 → 全部 `reused`、余额不变**；「查看我的订单」可见 3 笔；0 业务 console error。截图 `logs/v2160-batch/*.png`；脚本自清理（含同前缀遗留顾客兜底清扫）。
- **回归 `tools/_v2150_wizard_verify.js` 19 PASS / 0 FAIL**（代充 5 步向导按新 UI 更新断言 + **匿名兑换 4 步分支全绿** —— 证明 WS 多订阅改造未影响单账号/兑换链路）。
- **语法**：`node --check server.js` 通过；`public/site/index.html` 内联脚本语法 0 fail。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 全绿。
- **处置**：`tools/_v2120_topup_flow_verify.js` 断言的是 v2.12.0 旧 UI（v2.15.0 改向导时即已过期），本轮**弃用删除**。

### 下一步

- **补记（v2.15.0~v2.15.2 已交付但此前未写入本 CHANGELOG，本轮一并登记）**：①**v2.15.0 代充 5 步呈递向导**（详情页 ①登录 → ②获取 Session → ③提交 Session → ④支付 → ⑤自动开通；下单即发卡并直接进开通；`tools/_v2150_wizard_verify.js`）；②**v2.15.1 开通失败周期对账退款兜底**（订单层 `reconcileFailedActivationsOnce` + `startActivationRefundReconciler`，`ACTIVATION_REFUND_*` 可调，默认 5 分钟扫、账龄 > 12 分钟；幂等双闸门）；③**v2.15.2 代充卡池选卡策略**（`zovocard-client` 选卡控制面 + 后台「代充卡池（选卡策略·余额·审计）」面板 + 卡号脱敏 + 订单/任务日志记 `card_id/card_last_four`；`tools/_v2152_cardpool_verify.js` 22 PASS / 0 FAIL）。
- **待运维确认**：`kc_entitlement_prices` 里保留的示例报价 `pack_light_off40 × xplan_1 = 900`（$9.00）仍是验收用示例，上线前请确认真实运营口径（可在后台「权益报价」页调整或清除）。
- **未启动态的钱**：若某账号的 `run-process` 长时间未能启动（并发上限持续占满），其订单**不会自动退款**（退款对账要求该 CDK 有开通任务）；该单卡密仍有效，顾客可在「兑换卡密」页继续开通 —— 已在第 ⑤ 步文案如实说明。
- **未 git commit**（`git push` 因 No anonymous write access 不可用，勿重试）。

---

## v2.14.0 · 2026-10-17 · 前台布局对齐设计原型 + 租户级配色方案（5 套可选）+ 修复权益商品订单 biz_type 映射

**一句话概括**：按用户指令完成两件事 + 一处 bug 修复 —— ①**前台布局迁移**（`public/site/index.html`）：结构对齐设计原型 `design/前台整体设计-v1.0.0.html`（单行大标题 Hero、发光 CTA 卡、三列信任条、三张能力卡、热门商品双价卡网格、权益包网格、下单三步、`<details>` FAQ 手风琴、多列页脚），并把原浅色硬编码全部改走 token；②**租户级配色方案**：`kc_tenant_brand` 新增 `color_scheme`（容错 ALTER + 默认 `ink`），5 套方案（`mint`/`ocean`/`violet`/`ember`/`ink`）以 `:root[data-scheme=…]` token 块落在前台，前台 `applyBrand()` 按租户配置下发 `<html data-scheme>`；**前台顾客不提供配色切换入口**；三个品牌接口均读写 `color_scheme` 并做白名单校验，两个后台 UI 都加「配色方案」下拉；**平台默认 = `ink`「简约白」亮色**（平台租户 `primary_color`/`accent_color` 已清空），租户自定义 `primary_color` 仍优先覆盖 `--brand`。③**修 bug**：`server.js` 的 `bizTypeFromCategory()` 缺 `'entitlement'` 映射，导致权益商品订单 `biz_type` 落到 `other` —— 已补。

### 变更

- **前台布局迁移（`public/site/index.html`）**：结构对齐设计原型 `design/前台整体设计-v1.0.0.html` —— 单行大标题 Hero（去掉原双行）、发光 CTA 卡、三列信任条（用真实口径文案，非编造数字）、三张能力卡、热门商品双价卡网格、权益包网格、下单三步、`<details>` FAQ 手风琴、多列页脚；同时把原浅色硬编码全部改走 token。
- **租户级配色方案（`mysql-store.js` + `server.js` + `public/site/index.html` + `public/admin.html` + `public/tenant-admin.html`）**：`kc_tenant_brand` 新增 `color_scheme`（容错 ALTER + 默认 `ink`）；5 套方案（`mint`/`ocean`/`violet`/`ember`/`ink`）以 `:root[data-scheme=…]` token 块落在前台；前台 `applyBrand()` 按租户配置下发 `<html data-scheme>`；三个品牌接口（`/api/tenant/brand`、`/api/tenant-admin/brand`、`/api/admin/tenants/:id/brand`）均读写 `color_scheme` 并做白名单校验；两个后台 UI 都加「配色方案」下拉。**前台顾客不提供配色切换入口。**
- **平台默认配色 = `ink`「简约白」亮色**：平台租户 `primary_color` / `accent_color` 已清空（避免钉死强调色）；租户自定义 `primary_color` 仍优先覆盖 `--brand`。
- **修 bug · `bizTypeFromCategory()` 缺 `'entitlement'`（`server.js`）**：权益（entitlement）商品订单 `biz_type` 原落到 `other`，现补 `if (key === 'entitlement' || key === 'pack') return 'entitlement';`。

### 验证

- **C11 商品类型同口径 E2E `tools/_v2140_cat_e2e.js`（无头浏览器 + 管理员真实登录 + 真实顾客下单）15 PASS / 0 FAIL**：website（建站服务）/ entitlement（权益）两条同口径链路（后台建 → 前台可见 → 顾客可买 → 交付正确）；脚本自清理无残留；截图 `logs/v2140-cat-e2e/`。
- **亮色默认生效实测**：页面底 `rgb(247,248,250)`、主按钮 `rgb(59,108,246)`、标题单行、首页无深色残留、0 console error。
- **亮色下登录态实测**：代充列表、商品详情、我的钱包、充值弹层（白底；红色精确金额区醒目；「我已支付」初始 disabled，勾选后激活）均正常，0 console error。
- **配色切换链路实测**：把平台租户切到 `ocean` 时前台底色变 `rgb(7,11,20)`、主按钮变 `#4D9BFF`（「后台配置 → 接口 → 前台」链路通）。
- **门禁**：`check-docs-sync.js`（15 通过）/ `check-currency.js` / `check-root-hygiene.js`（7 通过）三门禁全绿。

### 下一步

- **待产品决策**：前台分类 Tab 只有 代充/成品号/建站服务，**没有「权益」Tab** → `kc_type='entitlement'` 的商品在前台无法从分类导航进入（首页推荐命中时才可见）。
- **待修（轻微 UI 不一致）**：非代充类（website/account）商品下单后，订单页按钮文案仍是「去开通（粘贴 Session）」，应随商品类型改写。
- **环境/数据遗留（非本轮产生）**：`.env` 的 `ADMIN_TRIAL_EMAIL`（kcbugtest@example.com）在 `kc_admin_users` 里不存在，校验脚本登录 401、需回落 `ADMIN_EMAIL`；历史孤立充值单 `rc_mvc0w2fz`（customer_id=100，顾客已删）未处理。

---

## v2.13.0 · 2026-10-17 · 商品全链路修复：新增商品可选类型 + 商城可见性口径纠偏（上架即售）+ 商城价取运营售价

**一句话概括**：用户反馈「新增商品没有让选商品类型」「新增了的代充商品在前台看不到」「要走整个业务流程，不是只看后台」。根因有两处并全部修复 —— ①后台「新增商品」对话框**没有商品类型选择**，代码还把卡片 category 写死 `recharge`，等于所有商品永远只能是代充；②前台目录用 **`api_enabled=1` +「绑定白名单货源」+「上游成本>0」** 做过滤与可售判定 —— 这三项本是「对外 API 分销」口径，却被当成了**商城上架门槛**：运营勾了「在售 + 商城显示」的商品只要没开 API 分销就**在前台彻底看不到**；即使开了，货源成本为 0（如 pro_5x/pro_20x）也会被判「不可售（缺货）」。同时商城价只认「租户零售价 / 上游成本×(1+加价)」，**运营填写的「售价」被无视**。本版把口径纠正为：**商城可见 = 在售 + 商城显示 + 状态 active；商城价 = 运营售价；「加价幅度」只用于对外 API 分销报价**，并补齐商品类型四选（代充/成品号/建站服务/权益）。

### 变更

- **商品类型可选（`public/admin.html` + `server.js` + `mysql-store.js`）**：新增商品/编辑对话框增加「**商品类型** *」下拉（代充 `recharge` / 成品号 `account` / 建站服务 `website` / 权益 `entitlement`），写 `kc_plans.kc_type` 并同步卡片 `card_json.category`（前台按此分 Tab）；`kc_plans.kc_type` ENUM 扩容补 `website`（容错 ALTER）；`planTypeNorm()` 白名单同步；编辑分支此前**完全没更新 kc_type**，现补齐；后台商品列表接口回吐 `kc_type` 供编辑预选。
- **前台可见性口径纠偏（`server.js`）**：主站目录与代理商后台商品接口的过滤条件由 `api_enabled=1` 改为 **`show_flag=1 AND sell_flag=1 AND status='active'`**；`tenantSkuAvailable()` 改为「可见 + 在售 + active + 有价格」，**移除** `api_enabled / upstream_plan_key 白名单 / 上游成本>0` 三处门槛（对外分销口径仍由独立的 `openApiSkuAvailable()` 承担，未改动 —— `POST /api/open/v1/*` 语义不变）。副作用修正：paused（已暂停）商品不再出现在前台（原来会以「缺货」卡片露出）。
- **商城价取运营售价（`server.js`）**：新增 `planListPriceCents()`，`tenantSkuPrice()` 优先级改为 **租户零售价 → 运营售价（`prices_json`，即商品管理「售价（美元）」）→ 上游成本×(1+加价幅度)**。原实现只有后两者，导致不绑货源的商品售价恒为 0（被判不可售）、且绑了货源时运营填写的售价被忽略。
- **前台分类来源改为商品类型（`server.js`）**：目录的 `category` 以 `kc_plans.kc_type` 为准（`cardParse()` 归一卡片时会丢弃 `category`，原先一律回落 `recharge`，导致「成品号」商品被归到代充 Tab）。
- **对话框文案（`public/admin.html`）**：补「商城可见规则」说明（勾「在售 + 商城显示」即出现在前台对应 Tab；商城价取你填的售价；加价幅度只用于对外 API）；「API 分销定价」勾选项文案改为「仅影响对外分销接口，不影响商城上架」，消除「不勾就看不到」的误导。

### 验证

- **商品全链路 E2E `tools/_v2130_product_e2e.js` 10 PASS / 0 FAIL**（无头浏览器 + 管理员真实登录 + 真实顾客下单）：F1 对话框含商品类型四选且可选「代充」→ F1b 保存成功并出现在商品列表；**F2 前台目录出现新建商品（`available=true`、商城价 = 填写的 $9.99）**；**F3 前台「代充」Tab 真实渲染出该商品卡片**（卡片列表含新建商品）；**F4 顾客下单成功 → 交付卡密（`KC-CMR29PQRSA7`）→ 自动进兑卡（Session 开通链路）**；**F5 再建「成品号」类型商品 → 前台 `category=account`、商城价 $19.90**；F6 后台 + 前台全程 **0 业务 console error**；F7 清理后前台目录不再包含测试 SKU。截图 `logs/v2130-product-e2e/*.png`。
- **回归**：功能套件 `tools/check-functional-suite.js` **50 PASS / 0 FAIL**（含买代充/买权益/兑卡）；核心业务流程用户场景 **29 PASS / 0 FAIL / 0 GAP**；代充 Session 流程（v2.12.0）**10 PASS / 0 FAIL**；`node --check server.js / mysql-store.js` 通过。
- **附带清理**：STEP0 清掉历史遗留测试商品 `功能测试商品*` 6 行与孤儿卡片/资费；修正后前台目录只剩真实商品（ChatGPT Plus 一个月 / GPT Pro100 菲区 ×3 / GPT Pro200）。
- **门禁**：`check-docs-sync.js`（15 通过）/ `check-currency.js` / `check-root-hygiene.js`（7 通过）三门禁全绿。

### 下一步

- **⚠️ 需要你确认的价格侧影响**：口径改为「商城价 = 运营售价」后，**`ChatGPT Plus 一个月`（xplan_1）的前台价将由 $11.50 变为 $15.00**（= 后台「售价（美元）」里填的 15；原 $11.50 是「上游成本 $10 × (1+15%)」算出来的）。若 $11.50 才是本意，请把该商品售价改回 11.50 即可（改完前台立即生效）。
- **待确认**：「四位类型里的『权益』（`entitlement`）商品目前不会出现在前台商品 Tab**（前台只有 代充/成品号/建站服务 三个 Tab，权益包走「权益包」入口与「权益」页维护）；若希望权益类商品也进商品 Tab，需要新增前台 Tab 与对应筛选。
- **运营操作提示**：上架商品只需勾「在售 + 商城显示」并填好售价即出现在前台；对外分销才需要开「API 分销定价」并绑货源。

---

## v2.12.0 · 2026-10-16 · 后台逐菜单走查并修复 3 个真实缺陷 + 菜单归组 + 代充 Session 流程恢复 + 前台展示方案

**一句话概括**：按用户指令完成三件事 —— ①**后台逐菜单走查**（跳开「支付与资产 / 自动化与任务」两组）：走查 17 个菜单 **0 console error / 0 个 ≥400 请求**，并实测「创建商品 / 创建权益包 / 配置前台商品 / 权益报价」四大流程；走查**发现并修复 3 个真实缺陷**（新建商品必 500、权益规则保存静默失败、权益列表恒空）；同时把**「续费管理」「免税地址」迁入「支付与资产」组**。②**前台展示方案**（`docs/方案/前台展示方案-v1.0.0.md`）：拆解参考站 `ezsub` 的配色/布局，并以**用户体验专家身份给出独立判断**（可借鉴 4 点、明确不照搬 5 点、分两步落地）。③**恢复「代充购买 → 输入并校验 Session → 开通」流程**（退场时被切断）：新增详情页 Session 收集与下单前强制校验、下单成功自动进兑卡预填并提交开通、订单详情「去开通」入口（**Session 仅存内存、不落库**）。

### 变更

- **菜单归组（`mysql-store.js` + `public/admin.html`）**：`BUILTIN_ADMIN_MENUS` 把 `cancel_renewal`（原 业务运营）与 `tax_addresses`（原 系统与安全）迁入 `g_assets`（sort 36/37，权限点不变：`order.read` / `admin.write`）；新增 **一次性幂等迁移** `ADMIN_MENU_GROUP_MIGRATIONS`（`UPDATE … WHERE group_key = 旧组`，仅在仍处旧组时迁移，不覆盖运维手工调整）；`NAV_MENU_FALLBACK` 同步（兜底菜单与接口菜单一致）。
- **缺陷 D1 · 新建商品必失败（`server.js`）**：新建商品分支写入 `kc_type='subscription'`，而 `kc_plans.kc_type` ENUM 仅 `recharge/account/entitlement` → `Data truncated for column 'kc_type'` → **500**。改用既有归一函数 `planTypeNorm(b.kc_type)`（沿用项目约定 R2 阶段统一 `recharge`）。
- **缺陷 D2 · 权益规则保存静默失败（`public/admin.html`）**：`authFetch()` **从不设置 `Content-Type`** —— 字符串 body 被按 `text/plain` 发送，`express.json()` 跳过解析 → `req.body={}` → 服务端 400「code 必填」，而前端仍提示「已保存」。修复：`authFetch` 在「字符串 body 且调用方未指定 Content-Type」时兜底补 `application/json`（FormData / Blob 不受影响）。**一处修复覆盖全部同类调用**（权益规则新建/启停等）。
- **缺陷 D3 · 权益页三处把 Response 当数据（`public/admin.html`）**：`loadEntitlementsList` / `_entResolveUserId`（用户持有权益查询）/ `loadEntitlementGrants` 直接读 `authFetch()` 返回的 `r.data`（恒 `undefined`）→ 规则列表恒显示「暂无规则」、邮箱定位恒失败。三处改为 `await res.json()` 后再取 `data`。
- **代充流程恢复（`public/site/index.html`）**：①代充商品详情页新增流程提示（① 下单 ② 获得卡密 ③ 粘贴 Session 开通）+ 显式声明「不需要账号密码、Session 不落库」，按钮改「**购买并去开通**」；②**下单前强制收并校验 Session**（复用 `rdCheckSession` 结构校验：JWT 头/签发方/aud/账号信息/`model.request`/有效期），不通过则拦截下单（避免为无效账号付款）；③下单成功交付卡密后**自动进入兑卡视图、预填卡密与已校验 Session 并自动提交开通**（新增 `goRedeem(cdk, auto)` + `state.pendingSession`，Session 仅存内存）；④**我的订单 → 订单详情**卡密旁新增「**去开通**」按钮；⑤非代充商品不出现 Session 区、按钮仍为「立即购买」。
- **前台展示方案（新增 `docs/方案/前台展示方案-v1.0.0.md`）**：参考站实测拆解（底色 `#0D0E12` / 强调色 `#76B900` / 卡片 `rgba(20,24,22,.7)`+`1px #1E2A1E`+`16px` 圆角 / Hero 双行标题 + 单发光 CTA / 信任条 / 3 能力卡 / FAQ 手风琴）；给出可直接落地的 token、首页布局规格（含与现状区块的对应表）、5 条组件规范、响应式与验收口径；**独立判断**：借鉴 4 点、明确不照搬 5 点（客户 logo 墙 / 大数字指标 / 粒子背景 / Cookie 与语言币种切换 / 金额面板用发光），建议**分两步落地**（先 token + 首页重排 + FAQ 手风琴，再评估信任条与深色默认化）。

### 验证

- **后台走查 `tools/_v2120_admin_walkthrough.js`（无头浏览器 + 管理员真实登录）26 PASS / 0 FAIL**：菜单归组 3 项断言（`g_assets=[checkout_debug,cards,cdks,sessions,billing,cancel_renewal,tax_addresses]` 共 7 项且原组已不含二者）；17 个菜单逐页走查**全部 0 业务 console error、0 个 ≥400 的 /api 请求**（概览/顾客/权益/权益报价/商品管理/站点与定价/上游/租户/API 客户/后台账号/角色与权限/菜单管理/操作审计/系统配置/登录日志/**续费管理**/**免税地址**）；流程 ①创建商品 PASS ②创建权益包 PASS（落库 + 列表可见）③配置前台商品 PASS（回执「已保存」）④权益报价页加载 PASS（9 个可售包 + 报价列表）。
- **缺陷复现与修复证据**：D1 修复前 `POST /api/admin/products/save` → 500 `Data truncated for column 'kc_type'`，修复后 **200**（`plan_id` 正常返回）；D2 修复前 400「code 必填」（抓包显示请求体其实含正确 code —— 证明是 Content-Type 缺失导致服务端未解析），修复后 **200** 且列表出现；D3 修复前 `ent_rules_list` 恒为「暂无规则」，修复后 UI 列表出现新建规则（`apiHas=true && uiList=true`）。
- **代充流程 `tools/_v2120_topup_flow_verify.js`（真实浏览器 + 真实下单/发卡）10 PASS / 0 FAIL**：F1 详情页提示 + Session 区 + 「购买并去开通」；**F2a 未填 Session 禁止下单（orders 0→0）**；**F2b 非法 Session 禁止下单**；**F3 合法 Session 下单成功 + 交付卡密 + 自动进兑卡并预填 Session**（卡密 `KC-95DA68NBPA6…`、订单数 0→1）；**F3b 已自动发出 `POST /api/run-process`**（链路打通，真实开通结果取决于上游与真实账号）；F4 订单详情「去开通」入口；F6 全程 0 业务 console error。截图 `logs/v2120-topup-flow/*.png`。
- **参考站实测抓取**：`logs/ref-ezsub/ref_desktop_viewport.png` / `ref_desktop_full.png` / `ref_mobile_full.png`（含取色与区块结构，供方案引用）。
- **回归**：功能套件 `tools/check-functional-suite.js` **50 PASS / 0 FAIL**；前台 UX 冒烟 **6 PASS / 0 FAIL**；充值体验 UX（v2.10.0）**20 PASS / 0 FAIL**；`node --check server.js / mysql-store.js` 通过。
- **门禁**：`check-docs-sync.js`（15 通过）/ `check-currency.js` / `check-root-hygiene.js`（7 通过）三门禁全绿。
- **测试数据已清理**：`kc-topupflow-*` / `kc-rcux-*` / `kc-gwdemo-*` 等测试顾客、订单、卡密、充值单、钱包流水与审计行已删除；走查产生的测试商品（`KC走查测试商品*` / `kcprobe商品*`）、测试权益规则（`walk_off20_*` / `kcprobe*`）与孤立卡片亦已清理。

### 下一步

- **待用户决策**：①前台展示方案是否按「第一步（token + 首页区块重排 + FAQ 手风琴）」开工；②「信任条」需真实运营数据（已交付单量 / 平均开通时长 / 到账率），是否提供；③深色是否设为默认（需先确认收银/充值面板可读性口径，方案 §3.3 已给最低对比度要求）。
- **运营提醒（本次走查暴露的系统性问题）**：`public/admin.html` 的 `authFetch` 此前不设 `Content-Type`，凡「传 JSON 但未显式带 header」的调用都会被服务端当成空 body —— 本版已一处收口修复，后续新增后台写接口请沿用 `authFetch`（勿再手工拼 header），并以「保存后回读列表」而非「看提示」来验收写入。
- **代充流程可选增强**：开通失败时的二次重试入口（复用订单卡密）；或按运营口径改为「先付款后粘贴 Session」的两段式（本版两条路径都保留）。

---

## v2.11.0 · 2026-10-16 · 接入 BEpusdt 真实收款：网关下单 + notify 服务端验签入账 + 生产模式关闭顾客自助入账 + 调度兜底对账

**一句话概括**：把「模拟收款」升级为**真实网关收款**——①**发起充值走网关下单**（`POST /api/v1/order/create-transaction`，显式 `fiat=USD` 防 CNY 折算少收款），收款地址/应付金额/收银台地址以网关返回为准（`token`/`actual_amount`/`payment_url`）；②**到账由 `POST /api/wallet/bepusdt/notify` 服务端验签入账**（签名算法拿当前在跑的 BEpusdt 实测通过；**验签只证明来源可信**，仍校验本地订单/金额/状态并**幂等入账**）；③**生产模式关闭顾客自助入账**（`confirm` → 403，防顾客自刷余额）；④**调度兜底对账**（定时 `POST /api/v1/pay/info` 查单，补入账/置过期，覆盖回调丢失）。**未配置网关时行为完全不变**（仍是模拟收款），本地开发环境即为此态。**未改 KC 原生业务逻辑。**

### 变更

- **接入层（新增 `bepusdt.js`）**：`isEnabled()`（`BEPUSDT_API_URL` + `BEPUSDT_API_TOKEN` 同时存在才算已配置）/ `sign(params, token)`（取非空参数、按参数名 ASCII 字典序拼 `k=v&…`、末尾拼 api 认证 token、MD5 转小写）/ `verifyNotify(payload, token)` / `isPaidStatus(status)`（2=成功）/ `fiatAmountUsd(orderId, cents)`（基础金额 + 单号派生 1~99 分认单尾数）/ `createTransaction({orderId, amountUsd, notifyUrl, redirectUrl})` / `queryTransaction(tradeId)`（`POST /api/v1/pay/info` 查单）。
- **数据层（`mysql-store.js`）**：`kc_customer_recharges` 新增 `trade_id` / `actual_amount` / `payment_url` / `notify_txid` / `notified_at` 五列（`CREATE TABLE` 同步 + 存量库**容错 ALTER** 逐个补列）。
- **后端（`server.js`）**：`POST /api/tenant/wallet/recharge` 已配置网关时**先落单再网关下单**（`amount` 必须是 JSON number，真实网关按 Go float64 反序列化）、回填 `trade_id`/`actual_amount`/`payment_url`/`pay_address`(/`token`)/`expires_at`（用网关 `expiration_time`），网关失败置 `canceled` 并返 **502 `GATEWAY_ERROR`**；未配置时**原模拟路径一字未改**；新增 `rechargePublicBaseUrl(req)`（`KC_PUBLIC_BASE_URL` 优先，否则回落到请求 Host，适配租户自有域名）；**新增 `POST /api/wallet/bepusdt/notify`**（**无鉴权**，靠签名 + 业务校验：未配置 → `status_code=503`，验签失败 → `400`；仅成功态入账；**金额复核**（链上金额 vs 下单应付，容差 0.01 USDT，不符 → `400` + 落 `recharge.notify_reject` 审计）；**幂等入账**；响应遵循网关约定 `{status_code:200,message:'success'}`）；**新增 `GET /api/tenant/wallet/recharge/:rechargeNo/status`**（状态轮询，任何状态都返 200）；`rechargePayPayload()` 新增 `mode`（`gateway`/`mock`）、`actual_amount`、`payment_url`、`trade_id`，`exact_amount` 在网关模式取 `actual_amount`；抽出 **`applyRechargeCredit(rc, opts)`** 作为**入账唯一实现**（模拟 `confirm` 与真实 `notify` 共用，仅 `pending→paid` 条件更新，天然幂等）；`recharge/confirm` 在**已配置网关时返 403 `SELF_CONFIRM_DISABLED`**；**新增调度兜底对账** `reconcilePendingRechargesOnce()` + `startRechargeReconciler()`（默认 60s，`RECHARGE_RECONCILE_INTERVAL_MS` / `RECHARGE_RECONCILE_LOOKBACK_HOURS` 可调；仅扫 `status='pending' AND trade_id<>''` 的近 2 小时单；网关 `status=2` → 复核金额后 `applyRechargeCredit` 补入账 + 落 `recharge.reconcile` 审计；`status=3` 且已过期 → 置 `expired`；**未配置网关则不启动调度**）。
- **前端（`public/site/index.html`）**：充值弹层第 2 步按 `mode` 分流 —— **网关模式**显示「**去收银台支付**」（`payment_url` 新窗口）+ 说明「链上自动确认到账、无需手动操作」+ **自动轮询**（`rcStartPoll()` 每 6s 调状态端点，到账即置第 3 步、toast、刷新钱包并关窗），**隐藏**勾选确认闸门与「我已支付」；**模拟模式**保持原有二次确认闸门与自助确认；新增函数已显式挂 `window`（`window.rcOpenPay`）。
- **配置**：`docker-compose.yml` 注入 `BEPUSDT_API_URL` / `BEPUSDT_API_TOKEN` / `BEPUSDT_TRADE_TYPE`（默认 `usdt.trc20`）/ `KC_PUBLIC_BASE_URL`（**默认空 = 模拟模式**）；新增 `./bepusdt.js:/app/bepusdt.js` bind mount（该容器按文件挂载，漏挂会 `MODULE_NOT_FOUND`）；`.env.example` 补对应说明。
- **口径**：**认单尾数改由网关给出** —— 我方下单只发「基础金额 + 2 位小数尾数」的法币 `amount`，网关按 `USD` 折算后返回 `actual_amount`（USDT），前台展示与实际应付**一律以 `actual_amount` 为准**；**入账口径始终是用户申请的整数金额（`amount_cents`），链上尾数不额外入账**。

### 验证

- **功能 + UX 验收 `tools/_v2110_bepusdt_notify_verify.js`（自包含：进程内起「网关桩」+ 拉起一个配了网关的 KC 实例 `:3199`，跑完回收）18 PASS / 0 FAIL**：F1 未配置网关实例仍为模拟模式（`mode=mock` + 模拟地址 + 4 位小数尾数）、F1b 未配置时 notify 503 拒收；F2 网关模式下单（`mode=gateway` + 网关地址 + 收银台地址 + 网关折算金额）；**F3 correct-signature notify 入账（余额 +$200）**；**F4 重放同一 notify 幂等（余额不变）**；**F5 错签名拒收（400）**；**F6 金额不符拒收（400）**；**F7 状态非成功（status=1）受理但忽略**；**F8 生产模式 `confirm` → 403 `SELF_CONFIRM_DISABLED`**；**F9 调度兜底：无 notify 也自动补入账（+$50，流水标注「对账补入账」）**；**F10 跨路径幂等（已对账入账的单再收 notify 不再加钱）**；U1 网关模式弹层（收银台入口 + 网关金额/地址 + 隐藏自助闸门 + 本地二维码）；U2 自动轮询到账；U3 模拟模式弹层勾选闸门保留；U4 既有要素回归（教程入口 / 「为什么带小数」/ 网络强警示）。
- **真实网关联调（非桩）**：用 `bepusdt.js` 直连当前在跑的 BEpusdt（`:8080`，`usdt-trc20`，地址 `TSYdNdbx…`）实测 —— **签名被网关接受**（`create-transaction` 返 `status_code=200` + `trade_id`/`token`/`actual_amount`/`payment_url`/`expiration_time`），`POST /api/v1/pay/info` 查单返 `status`/`actual_amount`；探针订单已清理（归还网关台账）。期间据实测修正两处：`amount` 必须为 JSON number（传字符串报 Go float64 反序列化错误）、必须显式 `fiat=USD`（否则网关按 CNY 折算成约 1/6.7 的 USDT）。
- **浏览器演示（接真实网关，`tools/_v2110_gateway_demo.js`，临时脚本）12 PASS / 0 FAIL + 7 张截图 `logs/v2110-gateway-demo/*.png`**：另起 `:3199` 实例接**真实** BEpusdt（**不动本地 `:3100` 的模拟环境**），走 钱包 → 充值第 1 步 → **第 2 步（真实钱包地址 `TSYdNdbx…` + 网关折算金额 + 本地二维码 + 「去收银台支付」+ 突出倒计时 + 网络强警示 + 「等待链上到账」）** → **打开真实 BEpusdt 收银台（200.73 USDT / 200.58 USD / Tron / 同一商户订单号）** → 关页引导（不丢单）→ 钱包「待支付充值单」→「继续支付」回到第 2 步；全程 0 业务 console error。**KC 前台展示的金额与网关收银台金额逐字一致**（同一商户订单 `rc_mvb2z7of_7ea724` 两侧均为 200.73 USDT）。
- **踩坑（已固化到脚本注释）**：网关的 `sqlite.db` 是 WAL 模式且由容器内 Go 进程持有，**第二个进程只能读到主库快照（看不到最新提交），直接写还有损坏风险** —— 后续一律**只用网关 HTTP API**（`create-transaction` / `pay/info`）与之交互，不再直接读写其 sqlite；网关侧演示订单为未支付态、随 `payment_timeout` 自动过期。
- **回归**：核心业务流程用户场景 **29 PASS / 0 FAIL / 0 GAP**；客服人工补录充值 **14 PASS / 0 FAIL**；前台 UX 冒烟 **6 PASS / 0 FAIL**；充值体验 UX（v2.10.0）**20 PASS / 0 FAIL**（模拟模式全流程未回退）；`node --check server.js / bepusdt.js / mysql-store.js` 通过。
- **门禁**：`check-docs-sync.js`（15 通过）/ `check-currency.js` / `check-root-hygiene.js`（7 通过）三门禁全绿。
- **测试数据已清理**：本轮验收/回归产生的 `kc-bepusdt-*` / `kc-gwdemo-*` / `kc-rcux-*` / `kc-e2e-*` / `kc-credit-*` 测试顾客与充值单、钱包流水、订单、CDK、审计行全部清除（KC 侧残留计数 0）。网关侧本轮创建的联调/演示订单**未能从 sqlite 删除**（WAL 第二进程不可见，见上「踩坑」），均为**未支付态**、随 `payment_timeout` 自动过期，不影响账务；此前清理时因 SQLite `LIKE` 大小写不敏感，误删过 2 条既有网关测试单（`KCUSDTEST1791168*`，未支付），已如实记录。
- **部署面**：`docker compose up -d app` 重建（新增 bind mount 生效）后 `kc-gpt-pay2-app` healthy；本地开发环境**未配置网关**，仍为模拟收款（不破坏现状）。

### 下一步

- **待用户决策**：把本地/生产环境切到真实 BEpusdt（填 `BEPUSDT_API_URL` + `BEPUSDT_API_TOKEN` + 可访问的 `KC_PUBLIC_BASE_URL`）后，顾客自助入账将自动关闭，改由 notify + 调度对账入账；切换前建议先确认网关为**非托管私人钱包**收款（无需私钥、资金直达用户钱包）。
- **上线前**：可访问的收银台/回调域名（现为内网地址）、BEpusdt 令牌轮换；`kc_entitlement_prices` 示例报价 `pack_light_off40 × xplan_1 = 900` 是否保留待运营确认。
- 可选增强（未做）：`notify` 到账后的**站内/邮件提醒**；对账结果运营可视化（本轮仅落审计 `recharge.reconcile`）。

---

## v2.10.0 · 2026-10-16 · 充值体验重构：3 步引导 + 扫码收款 + 突出倒计时 + 网络强警示 + 小数位解释 + 关页引导续付 + USDT 新手教程

**一句话概括**：按「用户交互体验专家」视角重构**顾客充值全流程** —— 把原先一屏堆信息、无引导、无扫码、关掉就当丢单的充值弹层，改成 **3 步引导式流程**（① 选金额 → ② **扫码转账** → ③ 确认到账），并为「**客户可能没用过 USDT**」补上**新手教程样例**。关键信息按风险等级重排：**倒计时突出**（剩余 5 分钟内自动转「紧急」脉冲态）、**网络强警示**（只支持 **TRC20**，选成 ERC20/BEP20 资金无法找回）、**精确金额超大字 + 一键复制 + 「为什么带 4 位小数」可展开解释**（认单编号原理）；**便利性**：收款地址**本地生成二维码可直接扫**（vendor 单文件库，无外链依赖）+ 地址/单号一键复制；**防丢单**：关闭充值页时弹「**这笔充值还没支付完**」引导（回显精确金额与剩余时间），并提供「**继续支付**」/「**去待支付充值单**」，钱包页新增「**待支付充值单**」区块可随时续付（含逐秒剩余时间）。**未改 KC 原生业务逻辑**；新增 1 个只读端点 + 钱包响应加 1 个字段。

### 变更

- **后端（`server.js`）**：新增 `GET /api/tenant/wallet/recharge/:rechargeNo`（**续付**：按充值单号取回支付信息；作用域锁 `customer_id + client_id`；已到账 409 `RECHARGE_PAID`、已关闭 409 `RECHARGE_CLOSED`、已过期 409 `RECHARGE_EXPIRED` 并把 pending 置 `expired`）；`GET /api/tenant/wallet` 响应新增 **`pending_recharges`**（本顾客本租户 `pending` 且未过期的充值单，含 `exact_amount` / `pay_address` / `expires_at`，最多 10 条）；抽出 **`rechargePayPayload()`** 统一「支付信息」载荷（POST 发起 / GET 续付共用，杜绝两处口径漂移）。
- **前端（`public/site/index.html`）**：充值弹层重构为 **3 步引导**（`#rc-steps` 步骤条 + `rcSetStep()`）；**倒计时上提为独立高亮区块**（`#rc-timer`，`rcSetCountdown()` 剩余 ≤5 分钟自动加 `.urgent` 脉冲动画并把文案改为「仅剩 MM:SS」）；**网络警示独立区块**（`#rc-chain`：必须选择网络 TRC20 / 选错无法找回）；**二维码区**（`#rc-qr`：本地 `qrcode` 库渲染 SVG，**内容为 `tron:` + 收款地址**，只带入地址、金额仍需手填，失败才显示「点此重试」）；**精确金额大字 + 复制 + `<details>` 解释「为什么金额后面要带 4 位小数」**；地址/单号均加复制按钮；**关页守卫** `rcGuardClose()`（充值单 pending 未过期时改弹 `#rcLeaveModal` 离页引导，`rcLeaveStay()` 继续 / `rcLeaveGoWallet()` 跳到钱包续付）；**背景点击与 ESC 同样走守卫**（`rcBackdrop()` / `rcStop()`）；钱包页新增「**待支付充值单**」区块（`renderPendingRecharges()` + 逐秒刷新 + 「继续支付」→ `resumeRecharge()` 直接进第 2 步）；新增 **USDT 新手教程弹层** `#guideModal`（3 步 + 两大常见事故警示 + 4 条 FAQ），入口 = 充值弹层「第一次用 USDT 充值？看 3 步图文教程」与钱包页「USDT 充值教程」按钮（**不进顶部导航，导航仍恒 5 项**）；新增函数已在 `window` 上显式暴露（内联 `onclick` 依赖全局名）。
- **依赖与资产**：**新增本地 vendored 二维码库** `public/js/qrcode.js`（`qrcode-generator` 的 MIT 单文件构建，含 UTF8 补丁，约 57KB），以 `<script src="/js/qrcode.js">` 引入 —— **不引入 npm 运行时依赖、不改镜像、不改 docker-compose**（容器 `node_modules` 在镜像内，加依赖需重建，故刻意避开）；`package.json` / `package-lock.json` **保持原样**。
- **口径**：扫码二维码内容为 `tron:{收款地址}`（**只带入地址**，金额必须按「精确金额」手填 —— 避免不同钱包对 TRON URI `amount` 支持不一致导致转错金额）；精确金额与「认单尾数」口径**未变**（尾数仅用于认单、不额外入账）。

### 验证

- **UX 测试用例（UX 专家 ≥3，无头浏览器实测 + 截图）**：`tools/_v2100_recharge_ux_demo.js`（临时脚本·不入库，Playwright）**20 PASS / 0 FAIL**，产出 9 张截图 `logs/v2100-recharge-ux/*.png` —— S1 钱包页含教程入口；S2 步骤条 3 步且停在第 1 步 + 按钮「生成收款码」；S2b 弹层内教程入口；S3 教程含 3 步 + 网络事故警示 + FAQ；S4 进入第 2 步「扫码转账」高亮；**S4b 本地生成二维码 SVG + 上下居中布局**；S4c 精确金额为 4 位小数；**S4d 倒计时突出展示（MM:SS）**；**S4e 网络强警示**；S4f「为什么带 4 位小数」解释 + 扫码提示；S4g 地址/单号已展示；**S5 关窗前弹「离页引导」不丢单**；S5b 引导回显精确金额 + 剩余时间；**S6 钱包页「待支付充值单」区块 + 继续支付**；**S7「继续支付」直接进第 2 步且金额/单号一致**；S8 未勾选闸门禁用 → 勾选启用；S9 确认到账 + 弹层关闭 + 余额更新；S10 0 业务 console error / 无「会员·等级·升级·VIP」术语。
- **功能/回归**：核心业务流程用户场景 `tools/_v290_core_flow_user_scenarios.js` **29 PASS / 0 FAIL / 0 GAP**（原「运营补单缺口」用例已改为**如实校验新入口可用**）；客服人工补录充值 `tools/_v290_manual_credit_verify.js` **14 PASS / 0 FAIL**；前台 UX 冒烟 `tools/_v290_frontend_ux_smoke.js` **6 PASS / 0 FAIL**（已同步新弹层选择器）；`node --check server.js` 通过、`public/site/index.html` 内联脚本语法 0 fail。
- **门禁**：`check-docs-sync.js`（15 通过）/ `check-currency.js`（未发现人民币痕迹）/ `check-root-hygiene.js`（7 通过）三门禁全绿。
- **测试数据已清理**：`kc-rcux-*` / `kc-e2e-*` / `kc-credit-*` / `kc-batch*` 测试顾客与临时管理员、订单、CDK、充值单、钱包流水、报价与审计行全部清除（测试残留计数 **0**）。

### 下一步

- 可选增强（未做，按需排期）：①真实接入 BEpusdt 后，`confirm` 改为**服务端验签的 notify** 入账（当前为模拟收款）；②二维码可选**带金额的 TRON URI**（需先确认主流钱包对 `amount` 参数的支持度）；③充值单到期前**站内/邮件提醒**；④把 `public/js/qrcode.js` 也替换掉后台 TOTP 那处**外链二维码服务**（`api.qrserver.com`，离线环境会失败）。
- 待用户确认的边界：新手教程目前是**前端样例弹层**（够演示）；若需正式运营文档（图文/视频/多语言），可另起一篇独立帮助中心页面。

---

## v2.9.0 · 2026-10-16 · 客服人工补录充值：链上认单漏单时由客服凭交易哈希人工入账（幂等防重复，类型 adjust 与系统到账分开统计）

**一句话概括**：核心业务流程测试发现**运营侧「帮客户补单/补余额」无任何入口** —— 顾客充值靠链上扫单认单（凭证 = 精确金额的 **4 位小数尾数**），**客户不输小数就会漏单**，而系统除「顾客自助点我已支付」外**没有任何服务端路径能写顾客余额**（`kc_customer_wallet_ledger.type` 早有 `adjust` 枚举却无人写入）。本版补上**客服人工补录充值**：新增 **`POST /api/admin/customers/:id/wallet/credit`**（`customer.write` 权限），客服在链上钱包核对确实到账后，用**链上交易哈希**作凭证人工入账 —— 同一哈希**幂等防重复入账**（409 `DUPLICATE_TX`）、流水类型记为 **`adjust`（人工干预，与系统自动到账的 `recharge` 分开统计）**、可选把关联的 `pending` 充值单**一并置为已到账**、全程落 **`customer.wallet_credit` 审计**（含余额前后 + 哈希）；技术后台「顾客管理 → 顾客详情 → 账单」新增「**人工补录充值**」弹层（风险提示 + 行内校验 + 二次确认），账单汇总新增「**人工补录合计**」卡片与系统「充值合计」并列。**无新表、未改 KC 原生业务逻辑。**

### 变更

- **后端（`server.js`）**：新增 `POST /api/admin/customers/:id/wallet/credit`（`requirePermission('customer.write')`）。入参 `{ amount_cents | amount, tx_hash(必填), recharge_no(可选), reason(可选) }`；校验：链上哈希必填（400 `TX_HASH_REQUIRED`）、金额需为 `$1 ~ $10000` 的正数（400 `INVALID_AMOUNT`）；**幂等**：按 `(customer_id, ref=tx_hash)` 查重 → 命中即 409 `DUPLICATE_TX`；入账后写流水 **`type='adjust'`**、`ref=tx_hash`、`note='客服人工补录充值（充值单 rc_xxx）· 原因'`；`recharge_no` 存在时把该顾客的 `pending` 充值单条件更新为 `paid`（`affectedRows>0` 才回 `recharge_status='paid'`）；落审计 `customer.wallet_credit`（`before: {balance_cents}` / `after: {balance_cents, amount_cents, tx_hash, recharge_no, reason}`）。同时 `customerWalletData()` 的账单汇总新增 **`adjust_total`**（`sums.adjust`，聚合 SQL 早已按 `type` 分组、`sums` 早已备有 `adjust` 槽位，仅需回吐）。
- **前端（`public/admin.html`）**：顾客详情「账单」tab 的「充值单」标题右侧新增「**人工补录充值**」入口（**仅 `customer.write` 角色渲染**，用批次 6 的 `adminCan()` 判定）；新增弹层 `#cust-credit-backdrop`（顾客邮箱 + 当前余额抬头、**红字风险提示**「仅在链上确认确实到账后再补录 / 认单靠小数尾数 / 同一哈希只能补录一次」、字段 = 补录金额 / 链上交易哈希 / 关联充值单号（可选）/ 补录原因（可选））；行内校验（金额 ≤ 0 或**未填链上哈希**直接提示且不关弹层）；提交前 `confirm()` **二次确认**（回显哈希与单号）；成功后 toast「已补录 $X，当前余额 $Y」并**重载顾客详情 + 切回账单 tab**。账单汇总由 4 张卡改为 **5 张**（**充值合计 / 人工补录合计 / 消费合计 / 退款合计 / 当前余额**）；流水类型标签 `adjust` 由「调账」改为 **「人工补录」**；`window.openManualCredit / closeManualCredit / submitManualCredit` 已显式暴露（内联 `onclick` 依赖全局名）。
- **前台（`public/site/index.html`）**：顾客钱包流水类型标签补 `adjust: '人工补录'`（顾客侧可见该笔为人工补录，与自助到账区分）。
- **口径**：**同一笔链上交易不可重复入账**（幂等键 = 交易哈希）；人工补录**只是把已真实到账的钱补记进顾客余额**，不改变金额口径；**账单上 `adjust`（人工）与 `recharge`（系统自动到账）分开统计**，便于对账审计；无新表（复用 `kc_customer_wallet_ledger` + `kc_customer_recharges`）。

### 验证

- **功能测试用例（功能测试工程师 ≥3）**：`tools/_v290_manual_credit_verify.js`（临时脚本·不入库）**14 PASS / 0 FAIL** —— F1 补录 $100 → 运营侧与顾客侧余额**同时**即时增加；F1b 流水 **`type=adjust`**（区别于系统自动到账）+ `ref=链上哈希` + 备注含「客服人工补录」；**F1d 账单汇总分开统计：充值合计 `$0.00` / 人工补录合计 `$100.00`**；F1c 审计 `customer.wallet_credit` 含**余额前后 + 链上哈希**；F2 同一哈希重复补录 → **409 `DUPLICATE_TX` 且余额不变**；F3 缺哈希 → 400 `TX_HASH_REQUIRED`；F4 金额 0 / 超上限 → 400 `INVALID_AMOUNT`；F5 带充值单号补录 → 该 `pending` 单被**置为 `paid`**；F6 `viewer`（无 `customer.write`）调用 → **403**；F7 顾客不存在 → **404**；F8 顾客侧余额含人工补录（$100 + $300 = $400，而充值合计不含）。
- **UX 测试用例（UX 专家 ≥3，无头浏览器实测）**：`tools/_v290_manual_credit_ux.js`（临时脚本·不入库，Playwright）**12 PASS / 0 FAIL** —— U1 顾客详情「账单」页出现「人工补录充值」入口且弹层容器就位；U2 弹层打开 + 4 字段 + 提交按钮（抬头显示顾客邮箱与当前余额）；U2b 含「链上/只能补录一次/确实到账」风险提示；U3 **未填哈希 → 行内报错且弹层不关闭**；U4 正常补录 → **弹层关闭 + toast「已补录 $50.00，当前余额 $50.00」+ 账单刷新出新流水**；U4b 账单区余额与流水同步刷新为 `$50.00`；**U4c 账单出现「人工补录合计」卡片 + 流水类型显示「人工补录」（与充值合计分开统计）**；U5 **`viewer` 角色不渲染补录入口**（`adminCan('customer.write')=false`）；U6 全程 **0 业务 console error**。
- **回归**：批次 1~6 功能脚本全绿（`_v230` 11/0、`_v240` 17/0、`_v250` 39/0、`_v260` 20/0、`_v270` 25/0、`_v280` 11/0）+ 核心业务流程用户场景 **28 PASS / 0 FAIL**（本轮测试报告见 `docs/验收/核心业务流程-用户场景测试-2026-10-16.md`）；`node --check server.js` 通过、`admin.html` 内联脚本语法 0 fail。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 三门禁全绿。
- **测试数据已清理**：`kc-credit-*` 测试顾客与 `kc-credit-viewer-*` / `kc-credit-uxviewer-*` 临时管理员及其钱包流水 / 充值单 / 审计 / 重置令牌行全部删除；核对 `kc_admin_users` = **1**（super）、`kc_customers` 无 `kc-credit-*` / `kc-e2e-*` 残留。

### 下一步

- 可选增强（未做，按需排期）：①**补发货**入口 —— 对 `status='failed'` 的订单用 `issueCdkByRef`（幂等键 `our_order_no`）重试履约；②人工补录**支持负数**（人工扣回，同样记 `adjust`）；③**链上扫单自动化**（真实 BEpusdt notify 接入后由服务端验签入账，替代模拟回调）。

---

## v2.8.0 · 2026-10-16 · 批次6 · 权限点细化收口：端点级 requirePermission 铺满 + 菜单按权限细粒度显隐 + 内置角色权限对齐

**一句话概括**：按《后台用户与账号管理方案》实施计划的**批次 6（v2.8.0）**，为技术后台**既有端点补齐端点级权限点校验**（新增 `ADMIN_ROUTE_PERMISSIONS` 映射表 + `/api/admin` 统一中间件，35 条规则覆盖 33 个受控端点），并**对账内置角色权限**与端点门禁 —— 修复「`finance` 缺 `menu.read` → `/api/admin/menus` 403 → 回落内置兜底菜单（泄漏无权页面）」与「兜底菜单权限点过期」两处缺口，同时让**启动/轮询按权限点跳过无权端点**（低权限角色不再刷 403）。**无新表**；**未改卡池 / 代理池等 KC 原生业务逻辑。**

### 变更

- **端点权限铺满（`server.js`）**：新增 `ADMIN_ROUTE_PERMISSIONS`（`{re, methods?, point}` 规则表）+ `adminRoutePermission(req)` 解析器，注册为 `app.use('/api/admin', …)`（位于 `authenticateAdmin` → `requirePasswordChanged` 之后）。命中且权限不足 → **403 `FORBIDDEN`**（`缺少权限：<point>`）。覆盖 `billing/subscription/checkout/task-logs`（`order.read`）、`runtime-logs/login-logs`（`audit.read`）、`cdks`（`entitlement.issue`）、`cards/sessions/proxies/browser-pool/config/site-config/region/telegram/hcaptcha/gpt-api/integration` 与 `security/(2fa-mode|paths)`（`system.config`）、`addresses`（`admin.write`）；`products/plans/listing-cards/upstreams/card-config` 与 `entitlements/grants|rules|prices` 采用 **GET=读点 / 非 GET=写点**（如 `pricing.read` / `pricing.write`）；`tenants/api-clients/api-portal` **GET=`tenant.read` / 非 GET=`tenant.write`**。**刻意不设门**：登录壳与自助端点（`login` / `verify-secondary` / `secondary/session` / `session` / 改密 / 2FA 自助）、共享读 `/api/admin/data`、`/api/admin/security/status`；已内联 `requirePermission` 的域（customers / roles / admins / permissions / menus / audit-logs / password-resets）不入表，避免“双门”重复。
- **内置角色权限对齐（`mysql-store.js`）**：`finance` 补 **`menu.read`**（后台导航由 `GET /api/admin/menus` 驱动，缺该权限会 403 并回落兜底菜单）；`seedAdminRoles()` 增**幂等对齐**分支（仅补齐「种子含而库中缺」的 `menu.read`，不覆盖运维已配置的其他权限点）。`BUILTIN_ADMIN_MENUS` 中缺失权限点的行补齐：`cancel_renewal/checkout_debug/billing/logs/automation_tasks → order.read`、`upstreams → pricing.read`、`cards/sessions/proxies/browser_pool → system.config`、`cdks → entitlement.issue`、`runtime_logs → audit.read`、`api_clients → tenant.read`（组行与 `dashboard` 保持空 = 始终可见）；`seedAdminMenus()` 改为**仅当库中该行 `permission` 为空时按种子补齐**（保留运维已配置的非空权限）。内置角色 `operator/viewer/finance` 仍按角色矩阵限定菜单可见面。
- **前端显隐与兜底同步（`public/admin.html`）**：新增 **`adminCan(point)`** 助手；`bootAdmin` 按权限跳过 `loadRegionConfig / loadGptApiConfig / loadIntegrationConfig`（`system.config`）与 `loadCardConfig`（`pricing.read`）；`loadData`（含 3 秒轮询）按权限跳过 `loadCdkList`（`entitlement.issue`）与 `loadCardPoolList`（`system.config`）—— 修复低权限角色**启动即刷 403 + 控制台报错**；`NAV_MENU_FALLBACK`（菜单接口失败时的内置兜底）**权限点同步为批次 6 口径**，避免兜底路径泄漏无权页面。导航渲染仍由 `adminMenuVisible` 按 `window.__adminMe.permissions` × `menu.permission` 过滤（组行 `permission` 为整组访问门）。

### 验证

- **功能测试用例（功能测试工程师 ≥3）**：`tools/_v280_batch6_functional.js`（临时脚本·不入库）**11 PASS / 0 FAIL / 0 SKIP** —— TC-F-16a `super` 对 33 个受控端点全量 GET 无 403/401；TC-F-16b **`viewer`/`operator`/`finance` × 33 端点**：**菜单权限点 ↔ 端点放行**完全一致（能看到的页面其 GET 必放行、看不到的必 403）；TC-F-16c 共享端点（`/api/admin/data`、`/security/status`、`/session`）对只读角色仍放行；TC-F-16d `viewer` 导航不含 `system.config` / `admin.write` 页面；TC-F-16e `viewer` 仍可见 `order.read` / `pricing.read` / `entitlement.read` 页面；TC-F-16f `operator` 含「CDK 管理」（`entitlement.issue`）但不含系统配置页。
- **UX 测试用例（UX 专家 ≥3，无头浏览器实测）**：`tools/_v280_batch6_ux.js`（临时脚本·不入库）**18 PASS / 0 FAIL** —— U1 `super` 导航 **32 项**、含「系统与安全」组与「操作审计」、组内子项可折叠展开；U2 `viewer` 导航**恰 18 项**（组门 `admin.write` 生效）、应见业务页全呈现、`system.config`/`admin.write`/`entitlement.issue` 页面**零泄漏**；U3 `viewer` 启动后 **API 403 计数 0 + 业务 console error 0**、概览中心可用（`active` 唯一 + dashboard 展示）、无 `undefined/NaN`；U4 全页无「会员/等级/升级/VIP」术语、5 折叠组名可见；U5 `finance`（**15 项**）含定价页、不含「租户与客户/系统与安全/CDK 管理/银行卡池」、启动零 403；U6 `operator`（**19 项**）含「CDK 管理」、不含系统配置类页、启动零 403。
- **回归**：批次 1 **11/0**、批次 2 **17/0**、批次 3 **39/0**、批次 4 **20/0**、批次 5 **25/0** 全 PASS；`node --check server.js` / `mysql-store.js` 通过；`admin.html` 内联脚本语法检查 0 fail。
- **门禁**：`check-docs-sync.js`（15 通过 / 0 失败）/ `check-currency.js`（未发现人民币痕迹）/ `check-root-hygiene.js`（7 通过 / 0 失败）三门禁全绿。
- **测试数据已清理**：`kc-batch6-viewer/-operator/-finance@example.com` 三个测试管理员（`kc_admin_users`）及其审计行、重置令牌行删除；核对 `kc_admin_users` 仅存 `super`、`kc_admin_roles` = 4（全内置）。

### 下一步

- **全 6 批次收口完成**（批次 1 `v2.3.0` ~ 批次 6 `v2.8.0`）；实施计划状态行更新为「已完成」。
- 需用户确认的边界：①数据驱动的「系统与安全」组行以 `admin.write` 作整组门 —— `viewer` 虽持有 `admin.read/role.read/audit.read` 仍**看不到**该组（与批次 4 退出条件 TC-F-11 一致，属**有意收紧**）；②`system.config` 复用为基础设施页（系统配置/卡池/Session/代理池/浏览器池/集成等）的统一权限点，未再细分；③`finance` 现含 `menu.read`（仅用于取导航，不含菜单管理页 —— 该页由 `admin.write` 把门）。

---

## v2.7.0 · 2026-10-16 · 批次5 · 租户员工完善：改角色 / 启用·禁用 / 重置密码 + 最后负责人保护与自身守卫

**一句话概括**：按《后台用户与账号管理方案》实施计划的**批次 5（v2.7.0）**，把代理商后台（`/tenant-admin`）的「**员工**」页从「只能新增」补成**完整账号管理** —— 新增 **`PUT /api/tenant-admin/staff/:id`**（改角色）、**`POST /api/tenant-admin/staff/:id/status`**（启用·禁用）两个端点，复用批次 3 已交付的 **`POST /:id/reset-password`**（一次性临时密码 + 强制首改）；**无新表**（复用 `kc_tenant_staff.status` / `password_hash` / `must_change_password`）；全部端点沿用 `authenticateTenantStaff + requireTenantOwner`（**仅负责人可管员工**）并落 **`staff.update` 审计**。**安全守卫**：不能降级 / 禁用**最后一个负责人**（`LAST_OWNER`）、不能禁用或重置**当前登录账号**（`SELF`）、角色只接受 **`owner|staff`**（防 `ENUM` 写入报错）；前端「员工」页改为**表格**（邮箱 / 角色下拉 / 状态 pill / 最近登录 / 操作）。**未改卡池 / 代理池等 KC 原生业务逻辑。**

### 变更

- **后端（`server.js`）**：新增 `countActiveTenantOwners(tid)`；`PUT /api/tenant-admin/staff/:id`（角色变更，非 `owner|staff` → 400；把**最后一个**活跃负责人降级 → 400 `LAST_OWNER`；成功落审计 `staff.update`（`before.role` → `after.role`））；`POST /api/tenant-admin/staff/:id/status`（`active|disabled`，非法值 → 400；禁用**自己** → 400 `SELF`；禁用**最后一个负责人** → 400 `LAST_OWNER`；成功落审计 `staff.update`）。同时为批次 3 的 `POST /api/tenant-admin/staff/:id/reset-password` **补 `SELF` 守卫**（重置当前登录账号密码 → 400），避免负责人自我锁死（租户后台**没有**自助改密 UI，一旦重置自己将无法再执行写操作）。
- **前端（`public/tenant-admin.html`）**：「员工」页 `loadStaff()` 重写为表格 —— 列 = **邮箱 / 角色（下拉 `owner|staff`）/ 状态（`启用`/`禁用` pill）/ 最近登录 / 操作**；行内操作 = **保存角色**（`PUT`）、**禁用·启用**（`POST …/status`）、**重置密码**（`POST …/reset-password`，成功后展示**一次性临时密码块** `#temp-pwd-wrap`：文案「一次性临时密码（30 分钟内有效…）」）；当前登录账号行标记「当前账号」且**「重置密码」按钮置灰**（`disabled` + `title="不能重置当前登录账号的密码"`）；非负责人访问该页显示「仅负责人可管理员工」；`window.saveStaffRole / toggleStaffStatus / resetStaffPassword` 已在 IIFE 尾部**显式暴露**（内联 `onclick` 依赖全局名，遗漏会静默失效）。
- **口径**：`kc_tenant_staff.role` 的 `ENUM` **只有 `owner|staff`**（历史踩坑：写 `operator` 会触发 MySQL `Data truncated for column 'role'`），故端点对非法角色**先校验再写库**；被禁用账号的**登录与已签发令牌**均立即失效（`authenticateTenantStaff` 校验 `status='active'`）。

### 验证

- **功能测试用例（功能测试工程师 ≥3）**：`tools/_v270_batch5_functional.js`（临时脚本·不入库）**25 PASS / 0 FAIL / 0 SKIP** —— TC-F-15（回归）owner 重置 staff → 一次性临时密码 + `reset_expires_in=1800` + 首登 `must_change=true` + 改密前写操作 403 `PASSWORD_CHANGE_REQUIRED` + 白名单改密放行；批次 5 新增：B5-01~03 **非负责人**改角色 / 改状态 / 重置密码均 **403**；B5-04 角色 `owner↔staff` 双向变更成功；B5-05 非法角色 `operator` → **400**、非法状态 `banned` → **400**；B5-06 降级最后一个负责人 → **400 `LAST_OWNER`**；B5-07 禁用当前登录账号 → **400 `SELF`**；B5-08 重置当前登录账号密码 → **400 `SELF`**；B5-09 禁用后**登录 401 + 旧令牌 401**、重新启用后恢复登录；B5-10 **跨租户改他租户员工 → 404**（作用域锁 `req.tenant.id`）；B5-11 审计 `staff.update` **四要素齐备**（actor/action/target/before/after）。
- **UX 测试用例（UX 专家 ≥3，无头浏览器实测）**：U1 员工页表头「邮箱·角色·状态·最近登录·操作」+ 4 行数据 + 角色下拉含「负责人/员工」+ 状态 pill 启用/禁用并存 + 三按钮齐备，`#staff-add` 可见、`#temp-pwd-wrap` 初始 `display:none` **PASS**；U2 点「重置密码」后临时密码块 display 变 `block`、`#temp-pwd-box` 为随机密码、toast「已生成一次性临时密码（30 分钟有效）」**PASS**；U3 状态开关**双向**实测（禁用→「已启用该员工」、再点→「已禁用该员工」）**PASS**；U4 **自身守卫**实测：当前账号行「重置密码」按钮 `disabled=true` 且 `title` 含「不能重置当前登录账号」**PASS**；U5 **0 控制台 error、0 禁词**（会员/等级/升级/VIP）**PASS**；U6 非负责人登录后「员工」页显示「仅负责人可管理员工」**PASS**。
- **回归**：批次 1 `tools/_v230_batch1_functional.js` **11/11 PASS**、批次 2 `tools/_v240_batch2_functional.js` **17/17 PASS**、批次 3 `tools/_v250_batch3_functional.js` **39/39 PASS**、批次 4 `tools/_v260_batch4_functional.js` **20/0 PASS**；`node --check server.js` 通过。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 三门禁全绿。
- **测试数据已清理**：独立测试租户 `cli_batch5test`（含 `kc_tenant_brand` / `kc_tenant_catalog` / `kc_tenant_domains` / `kc_tenant_staff` 5 行 / 相关审计与重置令牌）与批次 2~4 遗留测试管理员、自定义角色、批次 3 遗留测试顾客（含钱包流水 / 充值单 / 订单 / 权益授权）全部删除；核对 `kc_admin_users` = 1（super）、`kc_admin_roles` = 4（全内置）、`kc_admin_menus` = 32、`kc_tenant_staff` 无 `kc-batch%` 行。

### 下一步

- 批次 6（**v2.8.0 权限点细化收口**）：把剩余端点按权限点铺满 `requirePermission`，菜单按权限细粒度显隐收口；**无新表**。
- 需用户确认的边界：无（本批次未触碰红线表述；「员工」页属代理商后台既有页面，未改 KC 原生业务逻辑）。

---

## v2.6.0 · 2026-10-16 · 批次4 · 后台菜单数据驱动：kc_admin_menus + 菜单管理页 + 按角色权限过滤导航

**一句话概括**：按《后台用户与账号管理方案》实施计划的**批次 4（v2.6.0）**，把技术后台的**左侧导航从硬编码 DOM 改成数据驱动** —— 新建 **`kc_admin_menus`**（`menu_key` / `label` / `icon` / `group_key` / `is_group` / `sort` / `permission` / `visible` / `builtin`），种子取方案 §十 目标信息架构（并补齐该表未列但既有的「续费管理 / 上游管理」2 项，避免页面从导航失联），共 **32 项**；新增 **`/api/admin/menus`** CRUD（`menu.read` 读 / `menu.write` 写）与「系统与安全 → **菜单管理**」页；前端登录后**按当前角色权限点过滤**渲染导航（**保留 `switchPage` 契约与全部页面容器**）；「系统与安全」组行以 `permission='admin.write'` 作**整组访问门**，即 **`viewer` 等只读角色完全看不到该组**（TC-F-11 退出条件）。**未改卡池 / 代理池等 KC 原生业务逻辑。**

### 变更

- **数据层（`mysql-store.js`）**：新建 **`kc_admin_menus`**（`menu_key` 唯一 / `is_group` 区分可折叠组行 / `group_key` 所属组 / `permission` 所需权限点 / `visible` / `builtin` 内置不可删）；新增 `listAdminMenus()` / `getAdminMenuByKey()` / `upsertAdminMenu()`（无则插、有则更）/ `deleteAdminMenu()`（内置或含子项 → 拒绝）；`seedAdminMenus()` 幂等播种 **32 项**并标记 `builtin=1`；挂进 `ensureReady()`（`ensureAdminMenusTable` + `seedAdminMenus`）。
- **导航重排（种子 = 方案 §十 目标 IA）**：顶级保留「概览中心」；新建 **业务运营**（顾客管理 / 权益 / 权益报价 / 商品管理 / 站点与定价 / 续费管理 / 上游管理）、**支付与资产**（支付链接调试 / 银行卡池 / CDK 管理 / Session 管理 / **开通账单**（原「账单记录」））、**自动化与任务**（任务管理 / 自动化任务 / 运行日志 / **代理池** / **浏览器池**）、**租户与客户**（租户 / API 客户）、**系统与安全**（后台账号 / 角色与权限 / **菜单管理** / 操作审计 / 系统配置 / 免税地址 / 登录日志）。
- **API（`server.js`）**：`GET /api/admin/menus`（`requirePermission('menu.read')`）；`POST /api/admin/menus`（`requirePermission('menu.write')`，upsert + 审计 `menu.create` / `menu.update`）；`DELETE /api/admin/menus/:key`（`menu.write`，内置 400 / 含子项 400 / 不存在 404 + 审计 `menu.delete`）。
- **前端（`public/admin.html`）**：`<nav id="nav-menu">` 由 `renderAdminNav()` 依据接口数据渲染（组行可折叠、子项点击 `switchPage`），接口失败时回落内置 `NAV_MENU_FALLBACK`（= 种子副本，保证后台永远可用）；渲染规则 = `visible` × 当前角色权限点（`window.__adminMe.permissions`，超级角色 `['*']` 全放行）；`expandNavGroupForPage()` 改为按 `.nav-item[data-page]` 就近找组**通用展开**（删除原先硬编码的 `BUSINESS_PAGES` / `SECURITY_PAGES`）；`switchPageInternal()` 记录 `window.__currentPage` 使重渲染后保持高亮；新增「**菜单管理**」页（排序 / 显示名 / Key / 所属分组 / 图标 / 所需权限 / 可见 / 类型 表格 + 新增 / 编辑弹层：Key 编辑时锁定、权限点下拉取 `/api/admin/permissions`、分组下拉取现有组行；内置项无删除按钮）。
- **兜底与契约**：所有页面容器 id 与 `switchPage` 分派**一律未改**（菜单项 key = 页面 id），静态回归断言「每个菜单项 key 均有对应页面容器」通过（27 项齐全）；`ensureAdminSession()` 内 `await loadAdminMenus()` 后再做权限闸门与强制首改。

### 验证

- **功能测试用例（功能测试工程师 ≥3）**：`tools/_v260_batch4_functional.js`（临时脚本·不入库）**20 PASS / 0 FAIL / 0 SKIP** —— TC-F-09 菜单接口 200 且种子 = **32 项**、`g_security` 组 `permission=admin.write`、`menus` 项在位、32 项全 `builtin`；**静态回归**「每个菜单项 key 均有对应页面容器」通过（27 项）；TC-F-10 CRUD 新增 → 改名/改排序/置隐藏 → 删除全通过，**内置菜单删除 400**、**含子项的组删除 400**，审计 `menu.create` / `menu.update` / `menu.delete` 均落 `kc_audit_logs`；TC-F-11 **viewer 登录后可见菜单不含「系统与安全」任何子项**（可见 23 项、普通菜单仍在），且 viewer 无 `menu.write` → 新增菜单 **403**。
- **UX 测试用例（UX 专家 ≥3，无头浏览器实测）**：U1 超级管理员实测导航 **32 项 / 5 个分组**（业务运营 / 支付与资产 / 自动化与任务 / 租户与客户 / **系统与安全**），`window.__adminMe.permissions = ["*"]`，接口与 `adminMenusRaw` 均 32 条、`g_security` 在位 **PASS**；U2 **viewer 实测导航不含「系统与安全」「后台账号」「角色与权限」「菜单管理」「操作审计」（全 ABSENT）**，普通项均在，0 控制台 error、0 禁词 **PASS**；U3「菜单管理」页实测主标题「菜单管理」、表头「排序·显示名·Key·所属分组·图标·所需权限·可见·类型·操作」、**32 行**、工具栏「刷新」+「+ 新增菜单」、32 行全标「内置」且无删除按钮 **PASS**；U4 弹层实测「新增菜单」8 个字段（Key / 显示名 / 图标 / 所属分组 / 排序 / 可折叠组行 / 所需权限点 / 可见；分组下拉 6 项、权限下拉 18 项）+「取消 / 保存」，编辑态「编辑菜单：菜单管理」且 **Key 锁定**、perm=admin.write、group=g_security，关闭后 `display:none` **PASS**。
- **回归**：批次 1 `tools/_v230_batch1_functional.js` **11/11 PASS**、批次 2 `tools/_v240_batch2_functional.js` **17/17 PASS**、批次 3 `tools/_v250_batch3_functional.js` **39/39 PASS**；`node --check server.js / mysql-store.js` 通过。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 三门禁全绿。
- **测试数据已清理**：临时 viewer 管理员、临时菜单与相关审计噪声行已删除；核对 `kc_admin_users` = 1（super）、`kc_admin_roles` = 4（全内置）、`kc_admin_menus` = 32。

### 下一步

- 批次 5（**v2.7.0 租户员工完善**）：补 `PUT` / `status` / `reset-password` 等租户员工管理端点（**`kc_tenant_staff.role` ENUM 仅 `owner|staff`，勿写 `operator`**）。
- 批次 6（**v2.8.0 权限点铺满收口**）：把剩余端点按权限点收口，补 `menu.*` / `system.*` 等点位的越权断言。
- 需用户确认的边界：本批次按已批准方案 §十 重排了**技术后台**导航分组，与产品红线「KC 后台菜单不动（业务需求不能修改技术后台结构）」表述存在张力 —— 本批次属**平台管理工具**改造（非业务需求），如需回退可改 `kc_admin_menus` 行的 `group_key` / `sort` 复位居中。

---

## v2.5.0 · 2026-10-16 · 批次3 · 密码与账号安全 + 操作审计：一次性重置令牌 + 强制首改 + 操作审计页

**一句话概括**：按《后台用户与账号管理方案》实施计划的**批次 3（v2.5.0）**，把「改密 / 重置密码」这条最容易被做歪的安全链路一次性做正——新建 **`kc_password_resets` 一次性重置令牌表**（**只存 `sha256` 哈希、不存明文**、30 分钟过期、用后即焚），把**四类账号的重置场景统一抽象到同一张表**（平台 super 重置管理员 / 租户 owner 重置员工 / 管理员重置顾客 / 顾客自助找回留接口位）；批次 1/2 的「临时密码」端点**内部改走令牌表、对外契约不变**。同时补齐**登录安全**（密码强度策略、**强制首改闸门**：拿到临时密码后未改密则一切写操作 403、`password_version` 自增实现**强制下线**）与**操作审计覆盖面铺满**（改价 / 发权益 / 撤销权益 / 删卡 / 改商品卡片全部落 `kc_audit_logs`），技术后台新增「**操作审计**」页（筛选 + 分页 + 变更前后对比）。**未改卡池 / 代理池等 KC 原生业务逻辑。**

### 变更

- **数据层（`mysql-store.js`）**：新建 **`kc_password_resets`**（`token_hash` CHAR(64) 唯一 / `token_hint`（hash 前 8 位，仅供审计列表辨识）/ `account_type`(`admin|tenant_staff|customer`) / `account_id` / `expires_at` / `used_at` / `created_by_type` / `created_by`）；挂进 `ensureReady()`；新增 `createPasswordReset()`（写入用 `DATE_ADD(NOW(), INTERVAL ? SECOND)`）/ `consumePasswordReset()`（**单条 UPDATE 同时校验「未使用 + 未过期」**，`affectedRows==1` 即消费成功，否则回查判定 `used|expired|not_found`，时间比较走 SQL 避免时区问题）/ `listPasswordResets()`（**不返回 `token_hash`**）；`kc_tenant_staff` 加 `must_change_password`；新增 `listAuditLogs()`（分页 + 按操作人/动作/目标过滤，按 id DESC）。
- **重置令牌统一抽象（`server.js`）**：新增 `sha256Hex` / `validatePasswordStrength`（**≥8 位且同时含字母与数字**）/ `registerResetToken` / `issuePasswordReset` / `consumePasswordResetToken`（消费与拒绝均落审计 `password.reset_issued|consumed|rejected`）；批次 1/2 三个既有重置端点（平台 `admins/:id`、平台 `customers/:id`、租户 `customers/:id`）**内部改走令牌表、对外契约不变**（仍返回 `temp_password`，新增 `reset_expires_in: 1800`）；租户员工新增 `POST /api/tenant-admin/staff/:id/reset-password`（owner 限定，`account_type='tenant_staff'`）。
- **登录安全（`server.js` / `admin-auth.js`）**：**强制首改闸门**三层 —— 平台后台 `requirePasswordChanged`（写操作 403 `PASSWORD_CHANGE_REQUIRED`，白名单 `/change-password`、`/session`、`/security/status`、`/permissions`）、租户后台 `authenticateTenantStaff`（白名单 `/change-password`）、前台顾客 `authenticateCustomer`（白名单 `/auth/change-password`）；登录响应与 `/session`、`/me`、`whoami` 均回吐 `must_change_password`；`POST /api/admin/admins/:id/force-logout`（**`password_version = password_version + 1`** 令该账号全部旧令牌立即失效）；`/api/admin/change-password`、租户 `change-password`、顾客 `/api/tenant/auth/change-password` 三处统一改用 `validatePasswordStrength`；`POST /api/admin/password-resets/consume`（`admin.write`）/ `GET /api/admin/password-resets`（`requireSuperAdmin`）/ `GET /api/admin/audit-logs`（`audit.read`）。
- **场景 D 接口位**：新增 `POST /api/tenant/auth/forgot-password`（**通用文案防枚举**、审计 `customer.self_reset_requested`、响应带 `reserved:true`，令牌下发依赖的邮件/短信通道未接入）。
- **审计铺满（`server.js`）**：新增 `card.delete`（删卡）、`pricing.update`（权益报价与权益包定价）、`entitlement.issue` / `entitlement.revoke`（发 / 撤销权益）、`listing_card.update`（改商品卡片），统一走 `adminAuditActor(req)`。
- **前端（`public/admin.html`）**：「系统与安全」组内新增「**操作审计**」页（筛选：操作人邮箱模糊 / 动作 / 目标类型 + 查询 / 重置 + 列表 + 分页，列=时间·操作人·动作·目标·变更前·变更后·IP，越界值裁剪 120 字）；新增**不可关闭的强制改密弹层**（仅「确认修改」按钮，前端同样校验 ≥8 位含字母数字 + 两次一致，成功后清令牌回登录页）；`ensureAdminSession()` 记录 `must_change_password` 并在权限闸门后调 `maybeForcePasswordChange()`；按 `audit.read` 显隐「操作审计」入口。
- **前端（`public/site/index.html`）**：新增**顾客强制改密弹层** `#fpModal`；登录成功或 `me` 返回 `must_change_password` 时自动弹出，改密成功则清会话回首页并重新登录。

### 验证

- **功能测试用例（功能测试工程师 ≥3）**：`tools/_v250_batch3_functional.js`（临时脚本·不入库）**39 PASS / 0 FAIL / 0 SKIP** —— TC-F-07 重置顾客密码返回一次性临时密码 + `reset_expires_in=1800`、顾客首登 `must_change_password=true`、未改密时写操作 **403 `PASSWORD_CHANGE_REQUIRED`**、弱密码 400、自助改密 200 且标记清除、闸门放行；TC-F-14 令牌消费首次 200 / 二次 **410 `RESET_USED`** / 不存在 **404 `RESET_NOT_FOUND`**、列表**不落明文**且 `ttl_seconds=1800`；TC-F-12 冻结解冻顾客、改价幂等（回写原值 60000）、发权益 + 撤销、审计四要素齐备、`audit-logs` 分页可用；TC-F-15 租户 owner 登录 / 员工列表 / owner 重置 staff 成功 / staff 首登强制改密 / 写操作 403 / 非 owner 重置 **403** / 租户改密强度校验 400；TC-F-16 后台改密强度（<8 位 400、无数字 400）、临时管理员创建→登录→**force-logout→旧令牌 401**；TC-F-17 `forgot-password` 通用文案、未注册邮箱同文案（**防枚举**）。
- **UX 测试用例（UX 专家 ≥3，无头浏览器实测）**：U1 后台强制首改——临时账号登录后遮罩弹层**自动弹出**，标题「请先修改初始密码」、正文「你正在使用一次性临时密码（30 分钟有效）。为账号安全，修改密码前无法进行任何写操作。」、**无关闭/取消/跳过按钮**，改密（kcux2026→newpass2026）后回到 `/admin-login` **PASS**；U2「操作审计」页——主标题「操作审计」、三筛选 placeholder（操作人邮箱（模糊）/动作（如 pricing.update）/目标类型（如 customer））、表头「时间·操作人·动作·目标·变更前·变更后·IP」、当页 30 行、右侧「共 30 条」、分页「上一页 / 下一页」**PASS**；U3 控制台 **0 error**、全文 **0 命中「会员/等级/升级/VIP」** **PASS**；U4 主站前台 `GET /` 品牌「KC 直供」、导航恰 5 项、主要区块渲染正常、登录弹层正常、0 控制台 error、0 禁词 **PASS**。
- **回归**：批次 1 `tools/_v230_batch1_functional.js` 复跑 **11/11 PASS**；批次 2 `tools/_v240_batch2_functional.js` 复跑 **17/17 PASS**；`node --check server.js / mysql-store.js / admin-auth.js` 通过。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 三门禁全绿。

### 下一步

- 批次 4（**v2.6.0 菜单管理数据驱动**）：新建 `kc_admin_menus`（`key`/`label`/`icon`/`group`/`sort`/`permission`/`visible`），种子取计划 §十 目标 IA 表；`/api/admin/menus` CRUD；前端登录后**按角色权限拉取菜单渲染**，用数据源替换 `public/admin.html` 硬编码导航 DOM（**保留 `switchPage` 契约与页面容器**）；退出条件 TC-F-11（`viewer` 登录后菜单不含「系统与安全」整组）。
- 待登记取舍：①注册路径仍沿用旧「≥6 位」口径，仅改密路径应用新强度策略；②场景 D 自助找回仅留接口位（邮件/短信通道未接入）；③「2FA 下放租户 owner」未实现（租户员工登录无 2FA 基建），记为 deferred。

---

## v2.4.0 · 2026-10-16 · 批次2 · 平台管理员账号域 + RBAC 地基：多管理员 + 角色权限 + requirePermission + 旧登录兜底

**一句话概括**：按《后台用户与账号管理方案》实施计划的**批次 2（v2.4.0）**，把「后台不能管后台」这一最刺眼的缺口补上——平台从**单账号硬编码管理员**升级为 `kc_admin_users` **多管理员账号域**，并同批立起 **RBAC 三段式地基**（`主体(管理员) → 角色(kc_admin_roles) → 权限点(17 项) → 端点校验 requirePermission`）。技术后台新增「**系统与安全**」组：「**后台账号**」（列表/新增/改角色/禁用/重置密码，**仅超级管理员可写**）+「**角色与权限**」（内置 `super/operator/viewer/finance` + 自定义角色 + 权限点勾选矩阵）。**兼容红线**：现有单账号（`app_config`）自动迁移为**首个 super**，**旧登录路径兜底保留**，迁移后原账号仍可登录。

### 变更

- **数据层（`mysql-store.js`）**：新建 **`kc_admin_users`**（`email` 唯一 / `password_hash` / `password_version`（改密自增令旧令牌失效）/ `role_code` → `kc_admin_roles.code` / `status` / `must_change_password` / `note` / `last_login_at`）+ **`kc_admin_roles`**（`code` 唯一 / `name` / `permissions_json` / `builtin`）；挂进 `ensureReady()`；内置角色种子 `super`(全权 `['*']`)/`operator`/`viewer`/`finance`（`builtin=1`）；`seedAdminUsers()` 把 `app_config` 现管理员行**幂等迁移**为首个 `super`（仅当表为空时执行）。新增 `PERMISSION_POINTS`（17 项）与角色/管理员 CRUD 助手。
- **认证改造（`admin-auth.js` / `server.js`）**：`issueAdminToken(pv, email, {id, role, permissions})` 支持携带 `auid/role/permissions`；`verifyAdminToken` 放宽为「签名有效 + `sub='admin'` + `permissions` 非空」；`authenticateAdmin` 改为**带 `auid` 的令牌查 `kc_admin_users`**（校验 status/pv，组装角色权限），**无 `auid` 的旧令牌回落 `app_config` 单账号校验并视为全权 super**（旧登录不破坏）；新增 `requirePermission(point)`（`'*'` 全权放行）与 `requireSuperAdmin`。登录/2FA/`/api/admin/session`/`/api/admin/change-password` 全部按「优先表、回落 `app_config`」双路走通，令牌刷新保留 `auid/role/permissions`。
- **API（`server.js`，均注册于全局 `authenticateAdmin` 之后）**：`GET /api/admin/permissions`（权限点目录）、`GET /api/admin/roles`、`POST /api/admin/roles`（创建/更新，`super` 不可改）、`DELETE /api/admin/roles/:code`（内置/在用不可删）、`GET /api/admin/admins`、`POST /api/admin/admins`（创建，留空自动生成**一次性临时密码**并置首改）、`PUT /api/admin/admins/:id`（改角色/备注）、`POST /api/admin/admins/:id/status`（禁用/启用）、`POST /api/admin/admins/:id/reset-password`。**自保护**：不能禁用当前登录账号、不能移除/禁用最后一个 `super`；写操作全部落 `kc_audit_logs`（`admin.create/update/disable/enable/reset_password`、`role.create/update/delete`）。
- **顾客域接入权限点**：批次 1 的顾客端点补上 `requirePermission('customer.read')`（读）/ `requirePermission('customer.write')`（冻结·备注·改密·开号），作为「低权限角色越权 403」的可验证落点（`viewer` 只读、`operator` 可写）。
- **前端（`public/admin.html`）**：新组「**系统与安全**」（`shield-check` 图标，折叠组，深链自动展开）下两页——「**后台账号**」表格（邮箱/角色徽标/状态/首改/最近登录/备注/操作）+ 新增·编辑弹层（角色下拉）+ 一次性临时密码弹层（复制降级 `execCommand`）；「**角色与权限**」表格（角色/在用账号数/权限点摘要/备注）+ 角色编辑弹层（**权限点勾选矩阵** + 全选/清空）；`ensureAdminSession()` 记录当前 `role/permissions` 并据此**隐藏「+ 新增管理员」「+ 新增角色」按钮**（非 super 显示「仅可查看」）。

### 验证

- **功能测试用例（功能测试工程师 ≥3）**：`tools/_v240_batch2_functional.js`（临时脚本·不入库）**17/17 PASS** —— TC-F-13 迁移后原管理员账号仍可登录 + 会话含 `role=super`/`permissions=['*']`；TC-F-09 权限点目录 17 项（含 `admin.write`/`customer.write`）/ 内置四角色齐备且 `builtin` 标记 / 管理员列表含迁移来的 super；TC-F-16 不能禁用当前登录账号（400）；TC-F-10 新增管理员返回一次性临时密码，新账号可登录且 `role=viewer`；TC-F-10c **非 super 新增管理员 403**；TC-F-11 viewer 有 `admin.read`/`customer.read` → 列表可见，**无 `customer.write` → 冻结顾客 403**；TC-F-12 禁用后该管理员登录被拒 403；TC-F-09d~g 自定义角色可建/内置不可删/在用不可删/可删。
- **UX 测试用例（UX 专家 ≥3，无头浏览器实测）**：U1 新组「系统与安全」可展开、进入「后台账号」页标题与表格列（邮箱/角色/状态/首改/最近登录/备注/操作）及「超级管理员·启用」行 + 「+ 新增管理员」按钮 **PASS**；U2 新增管理员弹层字段（邮箱/角色/初始密码/备注 + 取消/保存）**PASS**；U3「角色与权限」页 ≥4 角色、`超级管理员` 显示「全部权限」+「内置角色」**PASS**；U4 角色编辑弹层含 角色代号/显示名/备注 + **约 17 个权限点复选框** + 全选/清空 **PASS**；U5 两页渲染文本 **0 命中「会员/等级/升级/VIP」**、**控制台 0 JS 报错** **PASS**。
- **审计**：管理员创建 / 改角色 / 禁用·启用 / 角色创建·删除实测落 `kc_audit_logs`（`actor_email`/`action`/`target_type`/`target_id` 齐备；**重置密码审计不含明文**）。
- **回归**：批次 1 顾客域脚本 `tools/_v230_batch1_functional.js` 复跑 **11/11 PASS**（新增 `requirePermission` 后超级管理员令牌 `['*']` 仍全通，无回归）；`node --check server.js / mysql-store.js / admin-auth.js` 通过。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 三门禁全绿。

### 下一步

- 批次 3（**v2.5.0 密码与账号安全 + 操作审计**）：新建 `kc_password_resets`（存 hash 不存明文、30 分钟过期、用后即焚）；四场景重置统一抽象（平台 super 重置管理员 / 租户 owner 重置 staff / 管理员重置顾客 / 顾客自助找回留接口位）；批次 1/2 的「临时密码」端点内部改走令牌表（**契约不变**）；写操作审计覆盖面铺满；登录安全（会话超时与强制下线、密码强度、强制首改、2FA 下放租户 owner）。

---

## v2.3.0 · 2026-10-16 · 批次1 · 后台顾客管理域：顾客四视图 + 冻结/备注/改密/开号 + 操作审计地基

**一句话概括**：按《后台用户与账号管理方案》实施计划的**批次 1（v2.3.0）**，把「顾客」做成后台**一等公民**——技术后台 `/admin` 与代理商后台 `/tenant-admin` 均新增「顾客管理」：列表（搜索/状态/租户筛选/分页）+ 详情抽屉**四视图**（概览 / 权益 / 订单 / 账单）+ 最低限度资金安全写操作（冻结/解冻、备注/昵称、重置临时密码、手动开号）。同批**先立操作审计地基**（`kc_audit_logs` + `insertAuditLog`），使本批所有写操作即有审计。**未改卡池/代理池等 KC 原生业务逻辑。**

### 变更

- **数据层（`mysql-store.js`）**：新建 `kc_audit_logs`（`actor_type`/`actor_id`/`actor_email`/`action`/`target_type`/`target_id`/`before_json`/`after_json`/`ip`）+ `insertAuditLog()` + `backfillOrderBizType()`，挂进 `ensureReady()`；`kc_api_orders` 加 **`biz_type`** ENUM（`topup/account/website/entitlement/other`，容错 ALTER + 历史按 `kc_listing_cards.card_json.category` 回填）；`kc_customers` 加 `must_change_password`、`admin_note`；`kc_customer_wallet_ledger.type` 扩 `adjust`。
- **订单打标（`server.js`）**：`openApiFindSku` 增 `LEFT JOIN kc_listing_cards` 取 `card_json`；`createApiOrderCore` 下单 INSERT 落 `biz_type`（由卡 JSON 品类映射）。定位：订单类型不再靠前端猜，**库内可筛**。
- **平台后台顾客 API（`server.js`，注册于全局 `authenticateAdmin` 之后）**：`GET /api/admin/customers`（分页/搜索/状态/租户）、`/:id`（概览聚合）、`/:id/wallet`（流水+充值单+汇总）、`/:id/orders`（**并两源**：`kc_api_orders` + `kc_customer_pack_purchases`，按 `biz_type`/`status`/`source` 过滤）、`/:id/entitlements`（**按 `customer_id` 命中**，非 `user_id`）、`POST /:id/status`、`/:id/note`、`/:id/reset-password`（一次性临时密码 + 强制首改）、`POST /customers`（开号）；写操作均落 `kc_audit_logs`。
- **代理商后台顾客 API（`server.js`，`authenticateTenantStaff`）**：同构 7 端点，作用域锁 `req.tenant.id`（越权 404）、**剔除 `cost_cents` 与租户字段**、重置密码要求 owner。
- **前端（`public/admin.html` / `public/tenant-admin.html`）**：新增「顾客管理」菜单与页面（列表 + 详情抽屉四 tab + 行内冻结/重置密码/备注/开号、一次性临时密码弹层）；金额一律 `$`、0 禁词。
- 顺带清除既有权益页占位文案里残留的一处身份化术语（改为「Plus 套餐 8 折」）。

### 验证

- **功能测试用例（功能测试工程师 ≥3）**：`tools/_v230_batch1_functional.js`（临时脚本·不入库）**11/11 PASS** —— 管理员登录；列表分页 + 搜索命中；`balance == balance_cents/100`；钱包流水**链式自洽且末条 = 当前余额**；订单 `biz_type` 筛选生效；权益按 `customer_id` 命中；冻结/解冻生效并恢复；重置密码返回一次性临时密码且置 `must_change_password`；不存在顾客返回 404 `code:'NOT_FOUND'`。
- **UX 测试用例（UX 专家 ≥3，无头浏览器实测）**：U1 列表渲染（数据行 + 筛选 + `$xx.xx`）**PASS**；U2 搜索空态不报错 **PASS**；U3 详情抽屉四 tab（概览/权益/订单含类型徽标/账单含余额流水+充值单）**PASS**；U4 全文 0 命中「会员/等级/升级/VIP」、金额全 `$` **PASS**；U5 控制台 0 JS 报错 **PASS**。
- **审计**：冻结/解冻/备注/重置密码实测落 `kc_audit_logs`（`action`/`actor_type`/`actor_email`/`target`/`before_json`/`after_json`/`ip` 齐备；**重置密码审计不含明文**）。
- **门禁**：`check-docs-sync.js` / `check-currency.js` / `check-root-hygiene.js` 三门禁全绿。

### 下一步

- 批次 2（**v2.4.0 平台管理员账号域 + RBAC 地基**）：新建 `kc_admin_users`/`kc_admin_roles`；`authenticateAdmin` 改造 + `requirePermission` 中间件；单账号迁移（保留旧登录兜底）；「后台账号」「角色与权限」页。

---

## v2.2.0 · 2026-10-16 · 充值页大改：精确金额认单 + 小数位强提醒；后台报错排查 + 图标库全局兜底

**一句话概括**：① 按用户指令「充值页要大改、对客户不输小数位要明显提醒」，参考区块链钱包充值行业规则（网络必须完全匹配、精确金额作认单标识、四舍五入无法自动匹配 → 转人工、手续费导致对方实收不足），**重写主站前台充值弹层**并把后端改为「每单派生唯一小数尾数的精确金额」；② 对 KC 技术后台 `/admin`（23 个 tab）与代充后台 `/business-admin`（7 个 tab）做**报错普查**——**231 次 `/api` 请求全 200、无 4xx/5xx**，唯一报错源于离线环境 lucide CDN 失载的级联抛错（「渲染 X 失败」假报错），在 3 个页面加**图标库全局兜底**消除。**严格只改充值页 + 图标兜底，未动卡池 / 代理池等 KC 原生页面的业务逻辑。**

### 变更

- **后端精确金额（`server.js`）**：新增 `rechargeExactAmount(rechargeNo, amountCents)`（插在 `mockPayAddress()` 之后）—— 由单号 `recharge_no` 的 SHA1 派生 4 位唯一小数尾数（0.0001~0.0099 USDT），拼在基础金额上（如 `$200` → `200.0065 USDT`）。**铁律：尾数仅作链上「认单标识」，不额外入账 —— 入账口径仍是整数分 `amount_cents`，余额精度不受影响**；与 `recharge_no` 一一对应且可确定性重算（**无需落库新列**，发起侧与对账侧可用同一函数复现）。
- **充值发起响应加字段（`server.js` · `POST /api/tenant/wallet/recharge`）**：`exact_amount`（精确金额）、`token`(`USDT`)、`network`(`TRC20`)、`min`/`max`（`$1`~`$10,000`）。`confirm` 回调仍按整数 `amount_cents` 入账（未改）。
- **充值弹层重写（`public/site/index.html`）**：① 标题加**网络徽标** `USDT · TRC20`，醒目红字「**仅限 TRC20 网络，选错链资金将无法找回**」；② 新增**红色「精确金额」区块** —— 大字展示精确到 4 位小数的应付金额 + 「复制精确金额」按钮 + 红色强提醒「**⚠ 少一位、多一分、或四舍五入成整数，系统都无法自动识别，将转人工处理**」（直面「不输小数位」问题）；③ 到账金额 / 收款地址（可复制）/ 单号 / 30 分钟倒计时 / **手续费说明**（手续费从转账额扣、需让「对方实收 = 应付金额」）；④ 新增**确认闸门**：勾选「我已确认：网络为 TRC20，转账金额与上方精确金额完全一致」方可点「我已支付」（未勾选点击 → 提示「请先勾选…」）；⑤ 「复制精确金额 / 地址」按钮 `copyText()` 优先 `navigator.clipboard`、**失败即降级 `execCommand('copy')`**；⑥ 充值金额输入限**整数美元**（小数尾数由系统生成，前端 `amount % 1 !== 0` 拦截并提示）；⑦ 失败自救提示。内联 `onclick` 处理函数 `copyRcExact`/`copyRcAddr`/`rcSyncConfirm` **显式挂 `window`**（沿用 Stage 3 既定口径）。
- **图标库全局兜底（`public/admin.html`、`public/index.html`、`public/subscription.html`）**：在 lucide CDN `<script>` 之后插入 `window.lucide = window.lucide || { createIcons: function(){}, icons: {} }` —— CDN 不可达（离线 / 内网）时 `lucide.createIcons()` 降为空操作，避免裸调用抛 `ReferenceError` 打断渲染、被外层 `catch` 吞掉后误报「加载 X 列表失败」。**未改卡池 / 代理池等任何业务逻辑。**

### 验证

- **功能测试用例（功能测试工程师 ≥3）**：
  1. 充值发起：`POST /api/tenant/wallet/recharge {amount:200}` → 200 且响应含 `exact_amount:"200.0065"`、`token:"USDT"`、`network:"TRC20"`、`min:1`、`max:10000`。**PASS**
  2. 尾数唯一 / 确定性：同单号重算 `rechargeExactAmount` 结果恒等；不同单号尾数互异（尾数 ∈ [0.0001, 0.0099]）。**PASS**
  3. 入账口径不变：`confirm` 回调仍按整数 `amount_cents` 入账（余额精度不受尾数影响），幂等防重复。**PASS**
  4. 后台报错普查：`/admin` 23 tab + `/business-admin` 7 tab 全遍历，**231 次 `/api` 请求全 200**、无 4xx/5xx；识别 **11 处**「前端引用但后端未注册」的孤儿端点（当前 UI 未接线）。**PASS**
- **UX 测试用例（UX 专家 ≥3，无头浏览器实测）**：
  1. 充值弹层 9 项断言（a~i）**全 PASS**：网络徽标 + TRC20 红字警告可见、精确金额大字渲染且取自接口、4 位小数强提醒在位、复制精确金额 / 地址按钮可用、确认勾选闸门生效（未勾选点「我已支付」被拦截）、整数金额校验生效、倒计时逐秒递减、375px 不破版。
  2. `/admin` 控制台 **0 错误**，原「加载卡池列表失败」假报错消失；卡池 / 代理池页面功能未受影响。
  3. 术语 / 币种：金额一律 `$`、无机场词典命中。
- **门禁**：功能套件 `tools/check-functional-suite.js` **50/50 PASS**（含 F9 充值组）；单元测试 `node node_modules/vitest/vitest.mjs --run` **27/27 PASS**；`node tools/check-docs-sync.js`(15) / `check-currency.js` / `check-root-hygiene.js`(7) **三门禁全绿**；`public/site/index.html` 内联脚本语法检查通过。

### 下一步

- **运营/接链待办**：充值仍为**模拟** —— 正式接入前 `confirm` 端点须改为「仅 BEpusdt notify 服务端验签入账」；精确金额尾数机制需在接链前与真实链上对账 / 认单流程做端到端联调。
- **孤儿端点（另案）**：11 处前端引用但后端未注册的端点对应 DOM 锚点已移除、当前 UI 未接线，如需清理另立需求。
- **git**：本轮按用户指令执行**本地 git 提交**（`git push` 因 No anonymous write access 仍不可用，勿重试）。

---

## v2.1.0 · 2026-10-16 · Xboard 代码级摘除：网站零引用 + 数据迁入 KC 原生表 + 功能/UX 验收全绿 + 工程文件退役标记

**一句话概括**：按用户指令「网站不再引用任何 Xboard，剔除相关代码，工程文件做标记」，在 v2.0.0（容器退场、主站接管）之上做**代码级摘除**——① 商品/站点配置主数据由 `xboard.v2_plan`/`v2_settings` **迁入 KC 原生表**（`kc_plans` 扩 7 列 + 新表 `kc_settings` + 卡片统一 `kc_listing_cards.card_json`）；② 技术后台商品/卡密/权益报价/站点配置、集成接口、`/api/integration/health`、排障端点**全部改读 KC 原生表**并删除 Xboard 服务端残留（`server.js` 0 处 xboard/v2_plan）；③ 业务模块（`business/`）**去掉对 Xboard 的直连**（顾客身份改本地校验 KC 签名令牌、只读对账不再读旧库）；④ 前台/后台去 Xboard 文案；⑤ 24 个 Xboard 时代工程脚本 + 部署引擎回滚函数 + 冻结的 `web/` **加退役标记**。**Xboard 容器仍只停不删**（回滚资产保留）。上线前**功能回归 50/50 + UX 3 面全绿 + 单元测试 27/27**。

### 变更

- **数据迁入 KC 原生表（`mysql-store.js`）**：`kc_plans` 新增 `prices_json`(JSON)/`content`(TEXT)/`is_topup`/`topup_amount`/`show_flag`/`sell_flag`/`sort_order` 七列（含 freshen 安装）；新增 `kc_settings`（`name` PK / `value` LONGTEXT）承载原 `v2_settings` 站点键值；卡片统一到 `kc_listing_cards.card_json`（`plan_id = kc_plans.id`）。
- **后台全面改读 KC 原生表（`server.js`）**：`/api/admin/products`、`products/save`、`card-config/list|save|reset`、`entitlements/prices`、`entitlements/user-lookup`（改查 `kc_customers`）、`site-config` 全部由 `xboard.v2_plan`/`v2_settings` 改为 `kc_plans`+`kc_listing_cards`+`kc_settings`；**新商品 code 生成**改为「现有最大 `xplan_<n>` 后缀 +1」，与 `kc_plans.id` 解耦（避免与既有 `xplan_26` 碰撞）。
- **删除 Xboard 服务端残留（`server.js`）**：`readXboardPatchStatus` 与 `/api/integration/health` 的 `xboard_patches` 字段；`V2_KC_PERIOD_MAP`/`diagnoseLegacyFields`/`GET /api/admin/diag/legacy-fields`；`XBOARD_DB_NAME`；`POST /api/admin/listing-cards/sync-to-v2`；集成接口 `source` 默认 `xboard`→`storefront`。
- **业务模块去 Xboard 直连（`business/`）**：`user-auth.js` 重写为**本地校验 KC 顾客签名令牌**（`adminAuth.verifySignedToken(token,{expectedSub:'customer'})`），删除外呼旧系统 `/api/v1/user/info`（`XBOARD_API_ORIGIN`）；`reconciliation.js` 只读对账**不再直连旧库**（删除 `v2_order`/`v2_user` 查询），返回 `legacySource:'retired'`、旧口径计数置 `null`；`repository.js` 的 `legacy_system`/审计 `actor_ref` 标签由 `xboard:*` 改为 `storefront:*`。
- **前端/后台去 Xboard 文案**：`public/admin.html` 删除「Xboard 补丁绿灯」卡片与其 JS、删除「全部同步到 v2」按钮与 `syncListingCardsToV2()`；`public/business-admin.html` 对账区标签改「旧系统订单（已退场）」等；`public/site/index.html` 注释去 Xboard。
- **工程文件退役标记**：24 个 Xboard 时代工具（`tools/migrate-*`、`reconcile-kc-xboard`、`kc_*-inject`、`xboard-*.php` 等）加「已退役」横幅；`kc-deploy_20261007.ps1/.sh` 的 Xboard 补丁/注入函数加 `RETIRED` 注记（**回滚资产，正常 deploy/start/verify 不触达**）；冻结的 `web/` 加退役横幅；`docker-compose.yml` 移除失效的 `XBOARD_API_ORIGIN` 环境变量。

### 验证

- **功能回归**：`tools/check-functional-suite.js` 17 组 **50/50 PASS**（登录 / 注册 / 创建商品 / 维护报价 / 买代充商品 / 买权益包 / 买 CDK / 充值 / 查订单 + 后台 CRUD 与权限）。
- **单元测试**：`node node_modules/vitest/vitest.mjs --run` **27/27 PASS**（含重写后的 `business-user-auth` 4 例 + `business-reconciliation`「旧系统退役」用例）。
- **UX 无头浏览器 3 面全绿**：`GET /`（主站前台：导航恰 5 项 + 「帮助与支持」页脚 + 0 禁词）、`GET /admin`（概览/商品管理/权益报价渲染正常、无「补丁绿灯」卡片）、`GET /business-admin`（对账首卡「旧系统订单（已退场）」、各 tab 正常）；三面均 **0 处可见 Xboard 文本**；唯一控制台报错为离线环境 CDN（unpkg lucide / google fonts）失载，属**环境非应用缺陷**。
- **残留核对**：`server.js` / `public/**` / `business/**` 均 **0 处** `xboard|v2_plan|v2_settings|v2_order|v2_user`；`node tools/check-docs-sync.js`(15) / `check-currency.js` / `check-root-hygiene.js`(7) **三门禁全绿**。
- **数据核对**：`kc_plans` `prices_json IS NOT NULL` = 8 行（已清洗历史测试商品）；`kc_business.biz_user_mappings` **0 行**（标签改名无数据迁移风险）；`/api/admin/login` 200、`/api/admin/cards` 200。

### 下一步

- **观察期与容器**：Xboard 容器仍 `docker stop` 保留（**未 rm**）；观察期内无回退事故后，由用户批准决定是否彻底 `docker rm xboard`（另案）。**切勿 `docker rm`/`compose down -v`**。
- **运营复核**：确认 `kc_entitlement_prices` 示例报价 `pack_light_off40 × xplan_1 = 900` 是否为真实口径；在后台「权益报价」页为各权益包录入逐商品一口价（未配置 = 按原价）。
- **未 git commit**（`git push` 因 No anonymous write access 不可用，勿重试）。

---

## v2.0.0 · 2026-10-16 · Xboard 退场（Stage 3.9）：主站根路径接管 + 清除注入 + 补丁链退役只读 + 容器只停不删

**一句话概括**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.9，执行 Stage 3 中**唯一移除回滚安全网**的破坏性步骤（用户拍板口径：**接管根路径 + 保留容器可回滚**）—— ① 主站 `GET /` 由 Xboard 注入前台**接管为 KC 原生主站前台** `public/site/index.html`；② 清除 Xboard 已应用的 `custom_html` 注入（**405268 → 0 字符**）；③ 9 处内核补丁 / 5 个注入源标记**退役只读**（部署不再重放、核查不再执行）；④ **Xboard 容器只停不删**（`docker stop xboard`，容器保留为回滚资产）。主站体验 100% 由 KC 原生前台承载（3.1~3.7 已重建 G1~G7/G9/G11）。**回滚路径完整保留**：置回 `inject=true` + `docker start xboard` + 跑 `tools/xboard-apply-custom-html.js`。

### 变更

- **主站根路径接管**（`server.js`）：`GET /` 由「仅 `?cdk=` 时落到 KC 前台、否则回落旧落地页 `public/index.html`」改为「**始终**落到 KC 原生主站前台 `public/site/index.html`」—— `?cdk=X` 自动进兑卡视图、无参进首页；旧 `public/index.html`（含「订阅」字样）不再由 `/` 提供。
- **清除 Xboard 注入**：Xboard 主题 `custom_html` 由 405268 字符清空为 0（`kcThemeLoaded` / `kcPanelLoaded` / `kcActivateLoaded` / `kc-home-portal` / `kc-topbar` 全部消失）；5 个注入源 + 9 处内核补丁随容器停用不再对外可见。
- **补丁/注入链退役只读**（`tools/xboard-patch-checks.js` + `tools/xboard-patch-check.js`）：新增 `RETIRED`（retired/since/at/reason）常量并导出；核查脚本在退役态直接上报 `{retired:true, ok:null}` 并 `exit 0`（不再 exec 容器、不再 `--fix` 重打）；`GET /api/integration/health` 的 `xboard_patches` 增加 `retired` + `note`；技术后台「Xboard 补丁绿灯」卡片在退役态显示「已退役」而非红字缺失。
- **部署引擎支持 retired 服务**（`kc-deploy_20261007.ps1` + `.sh`）：manifest 中 `retired:true` 的服务不参与 start/deploy/verify/open-urls（`stop` 仍覆盖全部）；`verify` 单列「Retired services」区（`[KEPT]`=已停且容器保留 / `[UP]`=退役但仍在跑，提示需停）；`list` 显示 `[RETIRED]` 标记。
- **`deploy-manifest.json`**：xboard 服务加 `"retired": true` 并更新 `note`（退场状态 + 回滚步骤：移除 `retired` → 置回 `inject=true` → 手动 start → 跑 `xboard-apply-custom-html.js`）。
- **承载面 QA 门禁退役**（`tools/check-admin-airport.js` + `tools/check-airport-lexicon.js`）：顶部加退役守卫（目标 `:7001` 已退场，打印 `[retired]` 并 `exit 0`）；币种口径由 `tools/check-currency.js`（不依赖 Xboard）继续承担。

### 验证

- **全链路 200 实测**（Xboard 已停 + 注入已清）：`/` · `/?cdk=ABC` · `/redeem` · `/site` · `/tenant` · `/tenant-admin` · `/admin` 均 200；`/api/integration/health` · `/api/public/site-config` · `/api/public/runtime` · `/api/tenant/catalog` · `/api/tenant/packs` 均 200；`health.xboard_patches.retired=true`。
- **根路径接管 UX 实测**（无头浏览器 6/6 PASS）：`GET /` 为 KC 原生前台首页（导航恰 5 项 代充/成品号/建站服务/权益包/我的订单、无「首页」；Hero + homeGrid + FAQ 齐全；**无「订阅」字样**）；`GET /?cdk=TESTCDK123` 进兑卡视图且预填；`/tenant` 租户站仍可打开。
- **端到端对照复跑 14/14 PASS**（`tools/_v148_e2e_parity.js`，临时脚本不入库；Xboard 停机状态下）：注册 → 充值(模拟收款回调，余额 $200) → 下单(tenant_web 从顾客钱包扣款) → 发卡(delivered + cdk) → 兑卡(`/api/verify-cdk` 识别卡密 + 套餐名) → 查单(顾客维度命中) —— 证明 KC 主站流程**不依赖 Xboard 容器**。
- **回滚演练 PASS**（容器级）：`docker start xboard` → 前台恢复 200 且 `custom_html` 仍为空（重启不自动重放）→ 跑 `tools/xboard-apply-custom-html.js` 恢复注入（405268 字符，首页含 `realProgress`/`data-kc-progress`）→ 重新清除（405268→0）→ `docker stop xboard`；全程主站 `GET /` 恒为 KC 原生前台 200。
- **部署引擎实测**：`kc-deploy_20261007.ps1 verify` —— 3 个 active 服务全 `[UP]`，xboard 归入「Retired services」并显示 `[KEPT]`。
- **三门禁全绿**：`check-docs-sync`(15) / `check-currency` / `check-root-hygiene`(7)；`node --check server.js` 通过。

### 下一步

- **观察期**：主站以 KC 原生前台运行一段时间，若出现回归按《Stage3切换前对照清单》§七 回滚（移除 `retired` → `inject=true` → `docker start xboard` → 跑 `xboard-apply-custom-html.js`）；确认稳定后可按原计划「彻底摘除」Xboard 容器（另案、需用户批准）。
- **另案（与退场无关，未处理）**：`docker ps` 遗留 `kc-gpt-pay2-web`（legacy-web，已冻结）与 `zfaka-redis`（zfaka 弃用残留）在跑，令 `kc-deploy verify` 报 2 个 drift；如需 verify 全绿可停掉两者。
- **运营侧动作**：确认 `kc_entitlement_prices` 里 Stage 3.5 插入的示例报价（`pack_light_off40 × xplan_1 = 900`）是否为真实运营口径，否则清除；并在后台「权益报价」页为各权益包录入逐商品一口价（单位：分；未配置 = 按原价）。

---

## v1.47.0 · 2026-10-15 · 退场第八步（Stage 3.8）：关闭 xboard.inject（配置变更，进入退场观察期）

**一句话概括**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.8，在 `deploy-manifest.json` 将 **xboard 服务的 `inject` 由 `true` 改为 `false`** —— 部署/启动**不再重放** KC 前端注入（custom_html + 清缓存 + octane reload），正式进入 **Xboard 退场观察期**。因 G1~G5 阻断缺口已全部闭环、G6/G9/G11 亦闭环，主站体验已由 KC 原生前台 `GET /site` 覆盖，不再依赖注入。**本步是配置变更，不摘容器、运行时不即时生效**；回滚 = 置回 `true` 并跑 `tools/xboard-apply-custom-html.js`（§七 一键回开）。

### 变更

- **`deploy-manifest.json`**：xboard 服务 `"inject": true` → `"inject": false`，并加 `note` 说明退场状态与回滚方式。该字段仅被部署引擎（`kc-deploy_20261007.ps1` / `.sh`）读取（决定 `svc_deploy`/`svc_start` 后是否调 `apply_injection`），不影响运行时。

### 验证

- JSON 合法：`node -e "require('./deploy-manifest.json')"` 通过；三服务 inject 均为 `false`（kc/bepusdt 本就 false）。
- 前置核验：G1~G5 阻断缺口闭环（3.1~3.5）、G6（3.6）、G9/G11（3.7）闭环；KC 原生主站前台 `GET /site` 已覆盖 首页门户 / 商品双价 / 下单 / 钱包充值 / 权益包 / 订单中心 / 兑卡 / 保留面入口。
- 回滚可用性：`tools/xboard-restore-custom-html.js`（恢复）与 `tools/xboard-apply-custom-html.js`（重放）均在位；`inject` 单开关可一键回开。
- 三门禁全绿：`check-docs-sync` / `check-currency` / `check-root-hygiene`。

### 观察期（退出条件）

- **退出条件 = 观察期内无回退事故**。该条件需实际运行观察（计划口径为一周），**不在此步内一次性完成**；期内主站体验以 KC 原生前台为准，如出现回归可即时按 §七 回滚（置回 `true` + 重放注入，约 2 分钟恢复）。

### 下一步

- Stage 3.9：摘除 Xboard 容器 + 9 补丁/注入链标记退役只读 —— **须待观察期满足「无回退事故」后执行**（3.9 会移除回滚安全网，不满足前置条件不得执行）。

---

## v1.46.0 · 2026-10-15 · 退场第七步（Stage 3.7）：保留面迁移（工单/知识库/邀请）+ 导航 5 项口径（G9/G11 闭环）

**一句话概括**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.7 落地 **保留面迁移（G11 闭环）** —— 依《Xboard原生功能处置清单》「工单/知识库保留、邀请保留入口但佣金不出圈」的定调，在主站前台**页脚新增「帮助与支持」行**：**工单支持 / 使用文档 / 邀请好友** 三个入口。运营可在租户品牌 `kc_tenant_brand.extra_json` 配 `ticket_url` / `kb_url` / `invite_url` 走**外链**（退场后的迁移去向），未配时回落**原生入口**：工单 → 引导到「我的订单 → 订单详情 → 申请售后」；使用文档 → 滚到首页「常见问题」（3.5 已建 FAQ）；邀请 → 弹层说明「邀请佣金在平台内结算、不对外开放提现」（**佣金不出圈**）。**同时复核导航 5 项口径（G9 闭环）**：顶部导航恒为 代充/成品号/建站服务/权益包/我的订单，无冗余「首页」入口。**Xboard 未退场、未关注入。**

### 新增

- **保留面入口**（`public/site/index.html`）：页脚 `.foot-links` 行三个入口 —— 工单支持 / 使用文档 / 邀请好友。
- **帮助处理函数**（`public/site/index.html`）：`openHelp(kind)` / `closeHelp()` —— 读 `state.brand.extra` 的 `ticket_url`/`kb_url`/`invite_url` 走外链；未配时：`kb` 回落到首页 `.faq` 滚动定位，`ticket`/`invite` 打开 `#helpModal` 说明（邀请文案含「邀请佣金在平台内结算，不对外开放提现」）。
- **`#helpModal`** + CSS `.foot-links`。

### 变更

- **页脚结构**：`<footer>` 由单一 `#footText` 扩为「帮助与支持行 + 版权文本」；版权仍读品牌 `footer_text`。
- **导航口径复核（G9）**：确认顶部 nav 恒为 5 项、顺序固定、无「首页」，与导航铁律一致（本步仅复核，未改动）。

### 验证

- 功能 **14/14 PASS**（`tools/_v146_help_verify.js`，不入库）：品牌接口返回 `extra`（F1）；页脚三入口 + invite 保留文案（F2）；导航恰 5 项且序列/无「首页」（F3）；`window.openHelp/closeHelp/openSupport` 已暴露（F4）。
- UX 全绿（浏览器实测）：页脚三链接居中显示；工单/邀请弹层文案正确；使用文档无弹层而是回首页并滚到「常见问题」；导航仍恰 5 项；375px 链接换行不溢出；0 JS 报错。
- 三门禁全绿：`check-docs-sync`(15) / `check-currency` / `check-root-hygiene`(7)。

### 去向（保留面）

| 保留面 | 去向 | 未配外链时 |
|---|---|---|
| 工单 | 外链 `ticket_url`（可选） | 原生：订单 → 申请售后 / 联系客服 |
| 知识库 | 外链 `kb_url`（可选） | 原生：首页「常见问题」 |
| 邀请 | 外链 `invite_url`（可选） | 原生：弹层说明（佣金平台内结算、不出圈） |

### 下一步

- Stage 3.8：`deploy-manifest.json` 关 `xboard.inject` 并观察（配置变更，无回退事故）。

---

## v1.45.0 · 2026-10-15 · 退场第六步（Stage 3.6）：订单中心增强（G6 闭环）

**一句话概括**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.6 落地 **订单中心增强（G6 闭环）** —— ①**订单列表状态筛选 tab**（全部/处理中/已完成/失败，带实时计数）；②**订单详情弹层**含「订单进度」**四节点时间线**（已下单/已支付/卡密已发放/交付完成）；③**「申请售后」弹层**（类型 + 描述 → `POST /api/tenant/after-sales` 落 `kc_after_sales`）；④**「联系客服」入口**（读租户品牌 `support_url`/`support_contact`）；⑤**充值单 30 分钟支付时限倒计时**（超时置灰确认）。**口径说明**：KC 原生订单在下单时即从顾客钱包扣款，**没有「待支付」态**，故筛选口径为 全部/处理中/已完成/失败（而非 Xboard 的 待支付/已关闭），「倒计时」落在确有 30 分钟时限的充值单上（与 Xboard 的待支付倒计时同源）。**Xboard 未退场、未关注入。**

### 新增

- **订单售后申请数据层**（`mysql-store.js`）：新建 `kc_after_sales`（顾客订单售后申请，`client_id`/`customer_id`/`order_no`/`request_type ENUM(failed|timeout|refund|other)`/`status ENUM(open|processing|closed)`/`message`/`created_at`/`updated_at`，`idx_customer` + `idx_order`），挂进 `ensureReady()`。
- **售后申请接口**（`server.js`）：`POST /api/tenant/after-sales`（`authenticateCustomer`）—— 作用域一律取 `req.tenant.id + req.customer.id`；校验订单归属（他人/不存在订单 → 404）；空描述/缺单号 → 400；非法类型归一 `other`；返回 `{id, order_no, request_type, status:'open'}`。
- **订单列表字段扩展**（`server.js`）：`GET /api/tenant/orders` 增加 `updated_at`（供详情时间线展示节点时间）。
- **订单中心前台增强**（`public/site/index.html`）：订单列表加状态筛选 tab（`.otabs`/`.otab`，带计数）+ 点击行打开「订单详情」弹层（订单号/商品/金额/卡密 + `#od-tl` 四节点时间线）+「申请售后」弹层（`#asModal`）+「联系客服」入口；充值弹层加「支付时限」倒计时（`#rc-count` + `rcSetCountdown`），超时自动置灰「我已支付」。
- **CSS**：`.otabs`/`.otab`/`.otab .n`/`tr.orow`/`.countdown`/`.tl .item`/`.tl .dot`/`.as-btns`。

### 变更

- **筛选口径适配 KC 原生订单状态**：KC 订单状态为 `created`/`delivered`/`failed`，映射「处理中/已完成/失败」；不再沿用 Xboard 的「待支付/已关闭」两 tab（KC 无待支付态）。
- **倒计时迁移到充值单**：Xboard 的「待支付 30 分钟倒计时」在 KC 原生落到 30 分钟时限的充值单上（`kc_customer_recharges` TTL），订单侧无待支付故不加假态。

### 验证

- 功能 **14/14 PASS**（`tools/_v145_order_verify.js`，不入库）：列表含 `updated_at`（F1）；自单售后可提交 200/`request_type`/`status=open`/`id>0`（F2）；参数校验 400（F3）；越权/不存在订单 404（F4）；未登录 401（F5）。
- UX 全绿（浏览器实测）：登录后订单筛选 tab 计数正确、切「失败」tab 显示「该状态下暂无订单」；订单详情四节点时间线 + 售后弹层 + 提交成功提示；充值「支付时限」倒计时逐秒递减；375px 不破版、表格横向滚动；0 JS 报错。
- 三门禁全绿：`check-docs-sync`(15) / `check-currency` / `check-root-hygiene`(7)。

### 下一步

- Stage 3.7：保留面迁移（工单/知识库/邀请）+ 导航 5 项口径（G9/G11）。

---

## v1.44.0 · 2026-10-15 · 退场第五步（Stage 3.5）：商品双价卡 + 首页门户（G5/G7 闭环）

**一句话概括**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.5 落地 **商品双价卡 + 首页门户（G5/G7 闭环）** —— ①**G7 权益价参与 KC 原生下单结算**：`GET /api/tenant/catalog` 每项加 `base_price`/`entitlement_price`/`entitlement_rule`/`entitlement_discount`，`POST /api/tenant/quote` 命中权益时锁权益价，`POST /api/tenant/orders` 按权益价扣顾客钱包并在交付后 `entitlementConsume` 扣次（幂等）；前台 `priceHtml()` 渲染「权益价大字 + 原价划线 + 『权益价』标签 + 『用 1 次权益 · 省 $X』」。②**G5 首页门户**：主站前台 Hero 之后新增 5 区块（为什么更省 / 三步完成 / 热门商品 / 权益包推介 / 常见问题），退场后首屏不再依赖 Xboard 注入的 `kc_home_portal`。**Xboard 未退场、未关注入。**

### 新增

- **首页门户 5 区块**（`public/site/index.html`）：Hero 后新增「为什么更省」（市面 vs KC 双价对照两卡）+「三步完成」（①②③三卡）+「热门商品」（`#homeGrid`）+「权益包推介」（`#homePackGrid`，读 `/api/tenant/packs`）+「常见问题」（4 条 `.faq`）。
- **商品双价卡**（`server.js` + `public/site/index.html`）：`GET /api/tenant/catalog` 每项新增 `base_price`/`entitlement_price`/`entitlement_rule`/`entitlement_discount`（`price` 仍=原价）；`POST /api/tenant/quote` 命中权益时锁权益价（`unit_price_cents`=权益价）；前台列表卡与详情弹层同步渲染双价。
- **权益价应用于原生下单结算**（`server.js` `/api/tenant/orders`）：`resolveCurrent` 内按权益价返回并记录 `entApplied{grant_id,rule_code,baseUnit,finalUnit}`；交付成功后调 `entitlementConsume`（`INSERT IGNORE` 幂等，扣 `remaining_uses`，扣到 0 标 `exhausted`），`try/catch` 不阻塞订单。
- **可选顾客身份中间件 `maybeCustomer(req)`**（`server.js`）：有效顾客令牌则回写 `req.customer`/`req.tenant` 并返回 customer，否则返回 `null` 不拒绝 —— 供 catalog/quote 在「访客原价 / 登录有权益优惠价」两态共用。
- **定价 helper**（`server.js`）：`entitlementActiveGrantsByCustomer(customerId)` + `entitlementPricingForCustomer(customerId, planCode, baseCents)`（顾客维度生效权益 → `loadEntitlementPrices` 索引 → `pickBestEntitlementPrice` 取最优；未配置/不低于原价/过期/用完 → 不优惠）。
- **主站前台 CSS**（`public/site/index.html`）：`.dp`/`.dp .ent`/`.dp .was`/`.dp .off`/`.save`/`.faq`/`.faq .qa`/`.faq .q`/`.faq .a`。

### 变更

- **权益价从「仅展示」升级为「参与实际结算」**（G7 收口）：完成 v1.43.0 留的「权益价应用到下单折扣」项。
- **首页目录加载时机调整**（`public/site/index.html`）：`loadCatalog()` 由无条件加载改为登录后加载（登录态目录附带权益价），并新增 `loadHomePacks()` 渲染首页「权益包推介」。
- **修复内联 onclick 未暴露**：`window.buyPack = buyPack`（与 v1.43.0 的「购买按钮点击无反应」同类问题，内联处理函数必须显式挂 `window`）。

### 验证

- **功能实测 19/19 PASS**（`tools/_v144_pricing_verify.js`，临时脚本不入库）：F0 未登录目录无权益价（`price=base`、`entitlement_price` 空）；F1 注册+充值+开通轻享；F2 登录后目录双价（base $11.50 / entitlement $9.00 / 省 $2.50）；F3 `quote` 命中权益锁价（unit 900 分）；F4 下单按权益价扣顾客钱包 $9 + 交付后权益扣次 5→4；F5 同 `client_ref` 幂等复用同单、仅扣 1 次（剩 3/5）；F6 无匹配权益报价的商品按原价（1500 分）。
- **UX 实测（无头浏览器）**：首页 5 区块齐全；商品列表与详情卡显示权益价大字 $9.00 + 原价划线 $11.50 + 「用 1 次权益 · 省 $2.50」；**375px** 无横向溢出、不竖排；本页 **0 JS 报错**。
- **回归与门禁**：`GET /site` / `/api/tenant/catalog` / `/api/tenant/packs` 200；`node --check server.js / mysql-store.js` 通过；`check-currency` / `check-docs-sync`（15）/ `check-root-hygiene`（7）全绿。

### 下一步

- **Stage 3.6（G6）**：订单中心增强（筛选 / 倒计时 / 时间线 / 售后 / 客服）。
- Stage 3.7~3.9：保留面迁移 + 导航 5 项（G9/G11）→ 关 `xboard.inject` 观察 → 摘除 Xboard。
- **红线（未满足不得关注入）**：G1~G5 全部落地并验收 + 一笔端到端对照 + `check-currency` 通过 + `check-airport-lexicon` 19/19 + 回滚预案就绪。

> **注**：为验证双价卡，向 `kc_entitlement_prices` 插入了示例报价 `pack_light_off40 × xplan_1 = 900`（$9.00），当前**保留**作为示例配置；运营可在后台「权益报价」页调整或清除。

---

## v1.43.0 · 2026-10-15 · 退场第四步（Stage 3.4）：权益包前台 + 我的权益 + 用余额开通（G4 闭环）

**一句话概括**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.4 落地 **权益包前台（G4 闭环）** —— 权益包 = 平台自有资产，退场后购买入口不能消失，故在 KC 原生前台重建：①数据层给 `kc_entitlement_rules` 加**售价** `sale_price_cents`（0=前台不可售）、给 `kc_entitlement_grants` 加**顾客维度** `customer_id`（与历史 Xboard `user_id` 并存）、新建顾客购买记录 `kc_customer_pack_purchases`（`client_ref` 幂等）；②前台 API `GET /api/tenant/packs`（可售目录）、`GET /api/tenant/entitlements`（我的权益）、`POST /api/tenant/packs/purchase`（**用顾客钱包余额开通**：扣款 → 发权益 → 记购买 + 写钱包流水，幂等 + 回滚）；③主站前台「权益包」视图替换原过渡态占位；④运营定价入口 `POST /api/admin/entitlements/packs/:code/price`。**本期只到「购买 → 发权益 → 我的权益可查」，权益价应用到原生下单的双价卡留 Stage 3.5（G7）。Xboard 未退场、未关注入。**

### 新增

- **权益包前台数据层**（`mysql-store.js`）：`kc_entitlement_rules` 加 `sale_price_cents`（权益包售价，分；0=前台不可售，容错 ALTER）；`kc_entitlement_grants` 加 `customer_id`（顾客维度，0=历史 Xboard 用户维度）+ 唯一键由 `uk_user_rule_active` 改为 `uk_owner_rule_active(user_id,customer_id,rule_code,status)` + `idx_customer_status`；新建 `kc_customer_pack_purchases`（`purchase_no` 唯一 + `uk_client_ref(customer_id,client_ref)` 幂等 + `grant_id` 回指）；`ensureReady()` 挂 `ensureCustomerPackPurchasesTable()` + `backfillPackSalePrices()`（历史两档回填 轻享=6000 / 尊享=60000，仅回填 `sale_price_cents=0` 的存量行）。
- **权益包前台 API**（`server.js`，均走 `authenticateCustomer`，作用域 `customer_id=req.customer.id` + `client_id=req.tenant.id`）：`GET /api/tenant/packs`（可售权益包目录，`sale_price_cents>0`，仅回名称/次数/有效期/售价）、`GET /api/tenant/entitlements`（顾客维度生效权益）、`POST /api/tenant/packs/purchase`（用顾客钱包开通：`client_ref` 幂等复用 → 已持有 active 权益 409 → 钱包条件扣款（不足 402）→ 顾客维度发权益（`INSERT IGNORE` 去重，`reused` 回滚余额）→ 记购买单 + 写钱包消费流水；购买记录落库失败回滚余额与权益）。
- **运营定价入口**（`server.js`）：`POST /api/admin/entitlements/packs/:code/price`（`requireSecondaryAuth`）——设置权益包售价（分，0=前台不可售）；`sale_price_cents` 独立于 `PATCH /rules`，避免被规则表单覆盖。
- **主站前台「权益包」视图**（`public/site/index.html`）：替换原过渡态占位 —— 「**我的权益**」区（权益包 / 剩余次数 / 有效期 / 生效中，空态提示）+「**可开通权益包**」区（卡片：名称 / 售价 / 「含 N 次权益 · 有效期 M 天」/ 备注 + 「**用余额开通**」按钮；已持有显示「已开通」徽章）；余额不足内联提示「余额不足，请先到「钱包」充值」；未登录给登录引导。

### 变更

- **权益包 = 平台自有资产的 KC 原生重建**（G4 闭环）：退场后 `#/pack` 购买入口不再依赖 Xboard 注入；权益包目录改由 `kc_entitlement_rules.sale_price_cents` 驱动（运营经新端点定价），购买从顾客钱包扣款并发放**顾客维度**权益（`customer_id`），与历史 Xboard 用户维度（`user_id`）并存于同一 `kc_entitlement_grants` 表。
- **权益价结算留待 Stage 3.5**（G7）：本期未接原生下单的权益价折扣（双价卡）。

### 验证

- **功能实测 18/18 PASS**（`tools/_v143_pack_verify.js`，临时脚本不入库）：`GET /api/tenant/packs` 未登录可见 2 个可售包（$60 / $600 且 currency=USD）；注册（platform 租户）→ 未登录 `entitlements` 401；钱包初始 $0 且余额不足购买 → **402 `INSUFFICIENT_BALANCE`**；充值 $100 后购买轻享 → 成功、余额扣至 $40；我的权益出现 1 条（剩余 5 / 共 5，`rule_code=pack_light_off40`）；**重复开通同包 → 409 `PACK_ALREADY_OWNED`**；`client_ref` 幂等不重复发权益；钱包流水含「开通权益包」消费；未授权调用管理端定价 → 401。
- **数据核对**：`kc_entitlement_grants` 新增顾客维度行（`user_id=0, customer_id=19, source=purchase, remaining_uses=5, status=active`）；`kc_customer_pack_purchases` 落 1 行（`price_cents=6000, grant_id=8, status=paid`）；`sale_price_cents` 回填生效（轻享=6000 / 尊享=60000）。
- **UX 实测（无头浏览器）**：`/site` 权益包视图「我的权益」空态 + 两张权益包卡（轻享 $60.00 / 尊享 $600.00）各带「用余额开通」按钮；点击「用余额开通」→ 短暂「开通中…」→ 成功后卡片变「**已开通**」徽章 + 我的权益出现「剩余 5 / 共 5，有效期至 2027-04-13，生效中」+ 钱包余额相应扣减 $60 并写消费流水；**375px** 卡片/表格无横向溢出、文字不竖排；本页 **0 JS 报错**。
- **回归与门禁**：`GET /site` / `/api/tenant/packs` 200；`node --check server.js / mysql-store.js` 通过；`check-currency` / `check-docs-sync`（15）/ `check-root-hygiene`（7）全绿。

### 下一步

- **Stage 3.5（G5/G7）**：商品页双价卡 + 首页门户（Hero / 双价 / 权益推介 / FAQ）。
- Stage 3.6~3.9：订单中心增强（G6）→ 保留面迁移 + 导航 5 项（G9/G11）→ 关 `xboard.inject` 观察 → 摘除 Xboard。
- **红线（未满足不得关注入）**：G1~G5 全部落地并验收 + 一笔端到端对照 + `check-currency` 通过 + `check-airport-lexicon` 19/19 + 回滚预案就绪。

---

## v1.42.0 · 2026-10-15 · 退场第三步（Stage 3.3）：钱包/充值前台 + 顾客级钱包（BEpusdt 收款模拟，G2 闭环）

**一句话概括**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.3 落地 **钱包/充值前台（G2 闭环）** —— 新增**顾客级钱包**（`kc_customers.balance_cents` + 独立流水 `kc_customer_wallet_ledger` + 充值单 `kc_customer_recharges`）；主站前台新增「**我的钱包**」视图（余额大卡 + 档位 $100/$300/$500 + 自定义金额 + 流水明细 + 充值弹层）；充值走 **BEpusdt USDT（TRC20）收款**（**模拟**：生成收款地址 → 前台「我已支付」触发收款回调入账，幂等防重复）；`tenant_web` 站内下单从**顾客钱包**扣款（open API 仍从**租户余额**扣），两条账本严格分离（R2 红线「用户资金与对接方资金分开记账」）。**Xboard 未退场、未关注入**。

### 新增

- **顾客级钱包数据层**（`mysql-store.js`）：`kc_customers` 加 `balance_cents`（容错 ALTER）；新建 `kc_customer_wallet_ledger`（顾客钱包流水：`recharge` / `consume` / `refund`，按 `customer_id` 维度）与 `kc_customer_recharges`（充值单：`channel=bepusdt`、`pay_address`、`status=pending|paid|expired|canceled`、`expires_at`）；两者挂进 `ensureReady()`。
- **钱包/充值 API**（`server.js`，均走 `authenticateCustomer`，作用域 `customer_id=req.customer.id` + `client_id=req.tenant.id`）：`GET /api/tenant/wallet`（余额 + 档位 + 近 50 条流水）、`POST /api/tenant/wallet/recharge`（发起充值：金额校验 $1~$10000 → 生成充值单 + 模拟 TRC20 收款地址，**不入账**）、`POST /api/tenant/wallet/recharge/confirm`（**收款回调**：`pending → paid` 条件更新入账 + 写流水，天然幂等、防重复回调）。
- **主站前台「我的钱包」视图**（`public/site/index.html`）：余额大卡 + 快捷充值档位 + 流水明细表 + 充值弹层（档位/自定义 → 收款地址/单号 → 模拟到账）；顶栏 `meBox` 增加「钱包」入口（登录后可见）；下单余额不足时内联「去充值」引导。

### 变更

- **共享下单核心 `createApiOrderCore`**（`server.js`）：`source='tenant_web'` 且带 `customerId` 时，**改从顾客钱包 `kc_customers.balance_cents` 扣款**并写 `kc_customer_wallet_ledger`；open API（`source='open_api'`）仍从**租户余额 `kc_api_clients.balance_cents`** 扣并写 `kc_api_balance_ledger`。履约失败时按同一账本原路退回。两条账本严格分离记账。
- **前台表格与弹层响应式**（`public/site/index.html`）：订单/钱包流水表加 `tbl-wrap` 横向滚动容器 + 表头单元格 `white-space:nowrap`（修 375px 下「关联单号」竖排）；弹层加 `max-height:90vh` + `overflow-y:auto`（修窄屏弹层与背景重叠）。

### 验证

- **功能实测 15/15 PASS**（`tools/_v142_wallet_verify.js`，临时脚本不入库）：未登录钱包 → 401；注册后钱包 $0.00 且档位 = [$100,$300,$500]；发起充值返回充值单 + `T` 开头地址且**未入账**；回调到账 → credited=true、余额 $300 且含充值流水；**重复回调幂等**（credited=false、余额不变）；越权确认他人充值单 → 404；低于最小金额 → 400；**站内下单从顾客钱包扣款并交付卡密**（扣款额 = 订单额）；余额不足 → **402 `INSUFFICIENT_BALANCE`**。
- **UX 实测（无头浏览器）**：注册 → 钱包页（余额 $0.00 / 三档 $100/$300/$500 / 流水区）→ 充值弹层（选 $300 → 生成 `T` 开头地址 + 单号 → 「我已支付（模拟到账）」→ 余额 $300.00 + 流水「充值 +$300.00」）全线 PASS；**375px** 下流水表横向滚动不竖排、弹层不与背景重叠且按钮可点，$100 档充值端到端可用（余额 $300→$400）；1500px 布局正常；金额全 `$`、**0 机场词**；本页无 JS 错误（控制台 4 条错误均来自其它标签页 `admin.html` / `fonts.gstatic.com`，与本页无关）。
- **回归**：`GET /site` / `/`（旧落地页）/ `/?cdk=X` / `/redeem` / `/tenant` 均 200，Stage 3.1/3.2 路由未回退。
- **门禁**：`node tools/check-currency.js` / `check-root-hygiene.js`（7）/ `check-docs-sync.js`（15）全绿；`node --check server.js / mysql-store.js` 通过。

### 下一步

- **Stage 3.4（G4）**：权益包页 `#/pack` + 我的权益 + 用余额开通。
- Stage 3.5~3.9：商品双价卡 + 首页门户（G5/G7）→ 订单中心增强（G6）→ 保留面迁移 + 导航 5 项（G9/G11）→ 关 `xboard.inject` 观察 → 摘除 Xboard。
- **红线（未满足不得关注入）**：G1~G5 全部落地并验收 + 一笔端到端对照 + `check-currency` 通过 + `check-airport-lexicon` 19/19 + 回滚预案就绪。

---

## v1.41.0 · 2026-10-15 · 退场第二步（Stage 3.2）：兑卡/激活前台页（/?cdk=）KC 原生实现（G1 闭环）

**一句话概括**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.2 落地 **兑卡/激活前台页（G1 闭环）** —— 主站前台新增「**兑换卡密 · 完成开通**」视图：卡密验证（`POST /api/verify-cdk`）→ 会话凭证本地校验（Session JSON / accessToken）→ 提交开通（`POST /api/run-process`）→ **WebSocket** 订阅 `jobKey` 实时进度；`GET /?cdk=X` 与新增 `GET /redeem` 均落到 KC 原生兑卡页（自动预填 + 自校验），代充闭环不再断在旧落地页。**Xboard 未退场、未关注入**。

### 新增

- **兑卡/开通前台视图**（`public/site/index.html`）：卡密验证 → 会话凭证校验 → 提交开通 → WebSocket 实时进度条；处理中的卡密自动恢复进度；失败 / 人工 / 维护态分别给出明确提示；提供「重新输入卡密」重置。
- **兑卡入口路由**：`GET /?cdk=X` → KC 原生主站前台（兑卡视图自动预填并校验）；新增 `GET /redeem`（等价入口，无参时直接打开兑卡视图）；路由注册于 `express.static` **之前**以接管带 `?cdk=` 的根路径。

### 变更

- **根路径 `GET /`** 由「始终 `express.static` 回落 `public/index.html`」改为「带 `?cdk=` 时交由 KC 原生兑卡页，否则 `next()` 回落旧落地页（Stage 3.9 由主站前台接管 `/`）」。

### 验证

- **路由/行为实测**：`GET /?cdk=TEST-CDK-123` → 200（KC 原生前台，含兑换卡密视图，0 机场词 / 0 人民币 / 无 `:3100`）；`GET /redeem` → 200 且默认打开兑卡视图；`GET /` → 200 旧落地页（回归未受影响）；`POST /api/verify-cdk` 无效卡密 → `success:false`「无效 CDK」；WebSocket 服务存在（`new WebSocket.Server({server})`，支持 `subscribe` + `jobKey`）。
- **UX 实测（无头浏览器）**：`/?cdk=TEST-CDK-123` 自动预填并自校验、显示「无效 CDK」；`/redeem` 默认显示兑卡视图（兑换卡密标题 + 卡密输入 + 验证按钮）；空输入点「验证卡密」→ 内联「请输入卡密」；5 项导航完整；**375px 不破版**；本页 **0 JS 错误**。
- **回归**：Stage 3.1 验收重跑 **14/14 PASS**；`check-currency` / `check-docs-sync`（15）/ `check-root-hygiene`（7）全绿。

### 下一步

- **Stage 3.3（G2）**：钱包/充值前台（余额 + 档位 $100/$300/$500 + 自定义 + BEpusdt 收款回调，模拟）。
- Stage 3.4~3.9：权益包页 `#/pack`（G4）→ 商品双价卡 + 首页门户（G5/G7）→ 订单中心增强（G6）→ 保留面迁移 + 导航 5 项（G9/G11）→ 关 `xboard.inject` 观察 → 摘除 Xboard。
- **红线（未满足不得关注入）**：G1~G5 全部落地并验收 + 一笔端到端对照 + `check-currency` 通过 + `check-airport-lexicon` 19/19 + 回滚预案就绪。

---

## v1.40.0 · 2026-10-15 · 退场第一步（Stage 3.1）：主站 KC 原生前台骨架 + 顾客登录/注册（platform 租户复用 kc_customers）

**一句话概括**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.1 落地 **主站顾客登录/注册（G3 闭环）** —— 新增 KC 原生**主站前台骨架**（`public/site/index.html`，新路由 `GET /site`）：品牌头 + **5 项导航**（代充/成品号/建站服务/权益包/我的订单）+ 首页/商品分类/详情/下单/我的订单；顾客**注册/登录/会话**复用既有 `/api/tenant/auth/*`（主站即 `cli_platform` 平台租户，令牌 `sub='customer'`、7 天、**不落库**）；`GET /api/tenant/catalog` 补 `category` 字段以支撑分类导航；平台租户**品牌播种**为「KC 直供」。**Xboard 未退场、未关注入**（阻断缺口 G1/G2/G4/G5 仍在）。

### 新增

- **主站 KC 原生前台骨架**（`public/site/index.html`，新路由 `GET /site`）：品牌头 + 5 项导航 + 首页（hero + 热门）/ 商品分类列表 / 商品详情 / 立即购买 / 我的订单；直调 `/api/tenant/*`（platform 租户作用域），顾客令牌独立存 `localStorage.kc_site_customer_token`（与租户站 `kc_tenant_customer_token` 隔离）；金额一律 `$`。
- **顾客登录/注册入口（G3 闭环）**：复用 `POST /api/tenant/auth/register|login` 与 `GET /api/tenant/auth/me`；主站请求无租户头/无域名绑定 → 回落 `cli_platform` 平台租户，注册/登录天然按租户隔离；跨租户令牌访问 → `403 TENANT_MISMATCH`。
- **`GET /api/tenant/catalog` 增加 `category`**（server.js）：`LEFT JOIN kc_listing_cards` 取 `card_json.category`（`recharge` / `account` / `website`，缺省 `recharge`），使主站导航可按分类筛选商品。
- **平台租户品牌播种**（mysql-store.js `seedPlatformTenant`）：平台租户无品牌行时写入 `brand_name='KC 直供'` + 主色 `#0F6E56` / 点缀 `#0B5341`，主站前台显示对外品牌名而非内部主档名「平台主站」。

### 变更

- **`seedPlatformTenant`（mysql-store.js）重构为两段式**：先「解析/创建平台租户 id」，再「播种品牌」——原实现多处提前 `return`，品牌播种无处安放。
- **`GET /api/tenant/catalog` 的 SELECT 增加 `kc_listing_cards.card_json` 并 LEFT JOIN**：返回体每项新增 `category`（对既有 `/tenant` 租户前台为向后兼容的加字段，行为不变）。

### 验证

- **功能实测 14/14 PASS**（`Host=localhost:3100` → 回落 platform 租户 `id=13`）：`T1 /site` 200 且含 5 项导航、0 机场词；`T2` `brand.kind=platform`；`T3` catalog 带 `category`；**F1** 注册 → 登录 → `me` 200 且身份一致；**F2** agent 租户（`cli_eca492`）令牌访问主站 `me`/`orders` → **403 `TENANT_MISMATCH`**；`F2b` 同租户 `me` 200；**US-3.3** 未登录 `orders` 401（引导登录，非白屏）。
- **F3 会话不落库实测**：`kc_customers` / `kc_api_orders` **无任何 token 列**（`information_schema` 命中 0），顾客行仅存 `email` / `password_hash` / `status` / `last_login_at`；令牌为服务端 2 段签名串（`payload.sig`，`sub='customer'`）。
- **UX 实测（无头浏览器）**：主站默认宽度 / **375px** / **1500px** 均不破版，5 项导航窄屏换行无溢出；「我的订单」未登录显示登录引导；登录弹层可开可关；品牌名显示「**KC 直供**」；金额全 `$`、0 机场词。
- **门禁**：`node tools/check-currency.js` 通过（0 人民币痕迹）；`node --check server.js / mysql-store.js` 通过；`node tools/check-docs-sync.js` 通过。

### 下一步

- **Stage 3.2（G1）**：兑卡/激活前台页（`/?cdk=`）在 KC 原生实现并对接 `/api/verify-cdk`（当前 `/kc-proxy/redeem` 302 到 KC `/?cdk=`，而 KC 根路径只有旧落地页，代充闭环断在这里）。
- **Stage 3.3~3.9**：钱包/充值前台（G2）→ 权益包页 `#/pack`（G4）→ 商品双价卡 + 首页门户（G5/G7）→ 订单中心增强（G6）→ 保留面迁移 + 导航 5 项（G9/G11）→ 关 `xboard.inject` 观察 → 摘除 Xboard。
- **红线（未满足不得关注入）**：G1~G5 全部落地并验收 + 一笔端到端对照（注册→充值→下单→发卡→兑卡→查单）+ `check-currency` 通过 + `check-airport-lexicon` 19/19 + 回滚预案就绪。
- **遗留（待用户决策）**：① 订单详情页「旧订阅折抵金额」是否隐藏（修掉可让 `check-airport-lexicon.js` 转 19/19）；② 邀请&佣金设置页「提现单申请门槛($)」文本。两项均登记于《Xboard原生功能处置清单》§六（R1 / R2），随 Stage 3 退场消失。

---

## v1.39.0 · 2026-10-15 · 多租户接手（Stage 2）：KC 自有顾客账号 + 租户白标前台 + 代理商后台 + 前台去 KC 端口

**一句话概括**：按《替换Xboard与白标多租户实施计划-v1.0.0》§十二 落地 **Stage 2 分步接手** —— KC 侧自建**顾客账号**（`kc_customers` + 注册/登录/会话）与**租户白标前台最小版**（`/tenant`：首页/商品/详情/下单/我的订单，品牌来自 `GET /api/tenant/brand`）；抽出**共享下单核心 `createApiOrderCore`**（open API 与租户前台同一套幂等 + 锁价 + 余额原子扣减 + 履约发卡）；**代理商后台**（`/tenant-admin` + `/api/tenant-admin/*`，员工登录后只看自己租户，无平台成本/上游/其他租户）；前台直连 KC 的请求改走 Xboard 插件服务端代理 `/kc-proxy/*`（前端源码不再出现 KC 端口）；Xboard 原生功能（工单/知识库/邀请/节点/流量）逐项定调落 `docs/`。**Xboard 未退场，主站切换留 Stage 3**。

### 新增

- **顾客账号数据层（mysql-store.js）**：新建 `kc_customers`（顾客账号，租户维度：email 唯一键 per tenant + password_hash + status）；`kc_api_orders` 加 `customer_id`（顾客维度，支撑「我的订单」）与 `source`（`open_api` / `tenant_web`）两列（容错 ALTER）。
- **顾客会话 API（server.js，租户作用域取自 `req.tenant.id`）**：`POST /api/tenant/auth/register`、`POST /api/tenant/auth/login`、`GET /api/tenant/auth/me`；顾客令牌复用签名机制（`sub='customer'`，7 天，**不落库**）。
- **租户站前台最小版**（`public/tenant/index.html`，`GET /tenant` 路由）：首页 / 商品列表 / 商品详情 / 下单 / 我的订单，品牌（品牌名/主色/点缀色/Logo/客服/页脚）经 `GET /api/tenant/brand` 渲染；金额一律 `$`、**不启用权益包**。
- **租户站前台 API（server.js）**：`GET /api/tenant/catalog`（含 `upstream_plan_key`）、`POST /api/tenant/quote`（**不返回 cost_basis**）、`POST /api/tenant/orders`（`authenticateCustomer` + `createApiOrderCore`）、`GET /api/tenant/orders`（仅本租户本顾客，不含成本）。
- **共享下单核心 `createApiOrderCore(opts)`**（server.js）：把 open API 的幂等 + 锁价 60s + 3% 价格漂移拦截 + 余额原子扣减 + 履约同步发卡收敛为一处；`POST /api/open/v1/orders` 改为薄包装（维持原错误码与幂等语义）。
- **代理商后台**（`public/tenant-admin.html`，`GET /tenant-admin` 路由）+ `/api/tenant-admin/*` P1 全套：`overview` / `orders` / `products`(GET/POST) / `brand`(GET/POST) / `domains`(GET; POST=owner) / `ledger` / `staff`(GET; POST=owner)；全部走 `authenticateTenantStaff`（`sub='tenant_staff'`），owner 才可改品牌/域名/员工（`requireTenantOwner`）。**红线**：不提供查看平台成本 / 上游通道 / 其他租户。
- **Xboard 插件服务端代理**（`tools/xboard-patches/KcIntegration/`）：新增 `ProxyController.php` + 路由 `/kc-proxy/site-config`（Http facade 原样透传 KC `GET /api/public/site-config`）与 `/kc-proxy/redeem`（302 → KC `/?cdk=`）；前端注入源改为走代理，**不再直连 KC 端口**。

### 变更

- **前台注入源去 KC 端口**（`tools/kc_home_portal.html` / `kc_theme_inject.html` / `kc_activate_inject.html`）：`KC_BASE` 由 `http://localhost:3100` 改为 `/kc-proxy`；`fetch(KC_BASE + '/api/public/site-config')` → `/kc-proxy/site-config`；兑卡跳转 `/kc-proxy/redeem?cdk=`。
- **`tools/check-admin-airport.js`**：管理端登录凭据改为优先读 `.env` 的 `ADMIN_TRIAL_EMAIL/ADMIN_TRIAL_PASS`（此前默认 `kcbugtest@example.com` 是**普通用户**、非管理员，且旧传参 `ADMIN_PASSWORD` 是 KC 后台口令、非 Xboard 管理员口令，导致管理端登录恒 FAIL）；dashboard 与 system 的站点名断言由「KC 加速」更新为「**KC 直供**」。system-tabs 保留原「全部保留页签 0 命中」断言 —— 曾试加「邀请&佣金页签无『提现』」硬断言，因该行在设置页 DOM 下 `HIDE_LABELS` 不生效而**回退**，改为登记于处置清单 §六 已知残留 R1。

### 验证

- **功能实测全绿**：目录/报价/下单/我的订单、**幂等复用**（同 `clientOrderNo` 复用同单）、**跨租户 403**、open API 回归 200、顾客注册登录、租户后台全套端点、**隔离与角色 403**、品牌保存后**租户缓存失效生效**。
- **数据核对**：平台租户 `id=13 code=cli_platform`；代理租户 `id=12 code=cli_eca492`；`kc_tenant_catalog(client 12, xplan_1, retail 1500, visible)`；租户下单后余额 `5000→3500`（扣 1500），open API 回归再扣 1150 → `2350`；`kc_api_orders` 落 `customer_id=7`、`source='tenant_web'`。
- **UX 实测**：`/tenant/`（标题/3 导航/hero/卡片 $11.50/详情/登录弹窗）与 `/tenant-admin.html`（3 字段登录→概览 $23.50/导航/商品表/品牌预填）均 **PASS**。
- **2.4 收口实测**：前端源码与线上页面**均无 `:3100`**；线上含 `/kc-proxy/site-config` ×2、`/kc-proxy/redeem` ×1；`xboard-apply-custom-html.js` 写入 custom_html（405105→405268）+ 清缓存 + `octane:reload`；代理实测 `/kc-proxy/site-config` 200、`/kc-proxy/redeem` 302 → `http://host.docker.internal:3100/?cdk=...`、`/plan/kc-cards` 200。
- **管理端断言**：`node tools/check-admin-airport.js` **33 PASS / 0 FAIL / 词典命中 0**（登录 ok；sidebar 4 项隐藏断言 + dashboard/plan/order/user/system 专项断言 + system 6 页签 0 命中 + 用户行菜单 + 套餐弹窗全部通过；报告 `logs/admin-airport/2026-10-15T15-50-08-059Z/report.json`）。
- **前台回归**：`node tools/check-airport-lexicon.js` **18/19**（唯一 FAIL = 订单详情「旧订阅折抵金额」漏隐藏，v1.36.0 既有问题，非本版本引入；已登记残留 R2）。
- **原生功能处置**：新增 `docs/方案/Xboard原生功能处置清单-v1.0.0.md`（工单/知识库/**保留**、邀请**保留入口但佣金不出圈**、节点/流量/订阅/权限组**隐藏**，逐项理由 + 断言落点）。

### 下一步

- **Stage 3（v2.0.0）退场**：主站（platform 租户）切到 KC 前台并对齐功能（首页/商品/下单/查订单/余额/兑卡）→ `deploy-manifest.json` 关 `xboard.inject` → 整体摘除；9 处内核补丁与注入链标记退役只读；原生功能处置清单落地。
- **遗留（待用户决策）**：① 订单详情页「旧订阅折抵金额」是否隐藏（修法二选一：放宽 `KC_FF_RULES` 行隐藏前置条件，或在 `kcFFRunRows()` 增加按 label 白名单隐藏分支）—— 修掉即可让 `check-airport-lexicon.js` 转 19/19；② 邀请&佣金设置页「提现单申请门槛($)」文本（`HIDE_LABELS` 在该 DOM 下不生效）是否本轮处理。两项均已登记于《Xboard原生功能处置清单》§六（R1 / R2），并随 Stage 3 退场消失。
- **可选增强（本期不做）**：「按租户分上游」需新增 `kc_plan_upstream_routes(tenant_id, plan_code, upstream_code, upstream_plan_key, priority)`；上游路由为平台级能力，现状天然正交。

---

## v1.38.0 · 2026-10-15 · 多租户地基（Stage 1）：租户主档 + 域名识别 + 技术后台「租户」页 + 补丁绿灯上报

**一句话概括**：按《替换Xboard与白标多租户实施计划-v1.0.0》§十一 落地 **Stage 1 地基** —— 数据层给 `kc_api_clients` 扩 6 列并新建 4 张租户表（域名 / 品牌 / 目录 / 员工）并播种「平台主站」租户；请求侧新增 `resolveTenant` 中间件（`X-KC-Tenant` 头 → `Host` 查域名表 → 回落平台租户）与公开接口 `GET /api/tenant/brand`；技术后台新增「**租户**」页（租户 CRUD + 品牌 + 域名 + 商品目录 + 员工账号）与租户员工登录接口；「商品管理」页补上**上游健康**可视图；`/api/integration/health` 新增 `xboard_patches` 字段 + 首页卡片显示补丁绿灯（9/9）。**不替换 Xboard，不改前台**。

### 新增

- **数据层（mysql-store.js）**：`kc_api_clients` 扩 6 列（`tenant_kind` / `settlement_mode` / `settle_period` / `credit_limit_cents` / `max_concurrent` / `upstream_channel`，均容错 ALTER）；新建 4 张表 —— `kc_tenant_domains`（host 唯一 → 租户）、`kc_tenant_brand`（品牌名/配色/客服/页脚等）、`kc_tenant_catalog`（租户级「可见 + 零售价」，不复制商品）、`kc_tenant_staff`（租户后台员工账号，role=owner/staff）；`seedPlatformTenant()` 播种 `cli_platform`（`tenant_kind='platform'`，主站即默认租户），全部挂进 `ensureReady()`。
- **`resolveTenant` 中间件（server.js）**：识别顺序 `X-KC-Tenant` 头 → `Host` 查 `kc_tenant_domains` → 回落 platform 租户，产出 `req.tenant`（进程内 30s 缓存；租户/域名变更即失效）。**铁律**：租户作用域一律取自 `req.tenant.id`，**禁止从请求体读 `client_id`**。
- **公开接口 `GET /api/tenant/brand?host=`**：只回品牌字段（品牌名/配色/客服/页脚/hero），不含任何业务数据。
- **技术后台「租户」页**（`public/admin.html`）：列表（类型/结算/域名/品牌/员工/状态）+ 新建租户（自动下发 API Key/Secret）+ 详情弹层（状态、品牌配置、域名绑定、商品目录逐商品零售价、员工账号新增/停用）。
- **租户后台接口**：`POST /api/admin/tenants[/(:id)]`、`/brand`、`/domains`、`/catalog`、`/staff` 全套 CRUD；`POST /api/tenant-admin/login`（租户员工登录，role=owner/staff）+ `GET /api/tenant-admin/whoami`（越权守门示例）。
- **补丁绿灯（Stage 1.4）**：新增 `tools/xboard-patch-checks.js`（把 9 项内核补丁核查定义抽成可 `require` 模块，供 CLI/部署/CI 复用）；`tools/xboard-patch-check.js` 核查后落盘 `data/xboard-patch-status.json`；`GET /api/integration/health` 新增 `xboard_patches` 字段；技术后台首页新增「Xboard 补丁绿灯」卡片（未上报时提示运行核查脚本）。
- **商品 ↔ 上游可视图（Stage 1.5）**：`GET /api/admin/products` 关联 `kc_upstreams` 与最新 `kc_upstream_health_snapshots`，「商品管理」页新增「上游健康」列（健康/降级/不可用/未探测 + 上游已暂停标记）。

### 变更

- `admin-auth.js` 导出 `issueSignedToken` / `verifySignedToken`（租户员工令牌复用同一签名机制，`sub='tenant_staff'`）。

### 验证

- **用例全绿**：`node tools/_v138_stage1_verify.js` **19/19 PASS**（US-1.1~1.6 / F1~F6 / 补丁上报 9/9）；覆盖「新建租户→绑域名→`host=` 取到该租户品牌」「品牌/目录/员工写入并持久化」「租户员工登录成功」「构造 `client_id=其他租户 → 403`」「停用/启用状态落库」「商品列表带上游可视图字段」。
- **UX 实测**：技术后台「租户」页 U1 列表与详情弹层渲染完整、U2 弹层可开可关、U3 390px 窄屏无横向溢出、U4 无禁词（会员/等级/升级/VIP）与 `¥` —— **全通过**；控制台仅 2 条 `ERR_ABORTED`（旧 `/admin.html` 探测与 Google 字体，非 JS 错误）。
- **数据层核对**：`kc_tenant_brand/catalog/domains/staff` 4 表已建、`kc_api_clients` 6 列齐备、`cli_platform` 已播种（`tenant_kind=platform`）。

### 下一步

- **Stage 2（v1.39.0）分步接手**：租户侧独立后台 `/tenant-admin`（员工登录后只看自己租户数据）+ 主站与租户站共用前台的品牌注入（`GET /api/tenant/brand` 驱动）+ 租户目录的零售价接入报价链路。
- **Stage 3（v2.0.0）退场**：Xboard 旧商城退场与数据迁移收尾。
- 遗留：订单详情页「旧订阅折抵金额」是否隐藏待用户决策；「按租户分上游」为可选增强（表 `kc_plan_upstream_routes`），本期不做。

---

## v1.37.0 · 2026-10-15 · 工程目录归档整理 + 替换 Xboard 与白标多租户方案定稿

**一句话概括**：按用户指令给工程目录"瘦身归档"——根目录 138 个顶层文件、72 个 `_*` 临时脚本、tools 下 281 个 `_*` 项统一收进 `archive/`（**只移动不删除**，逐项登记 `_MOVE_LOG.md`），并新增 `tools/check-root-hygiene.js` 守护根目录整洁（挂 pre-commit）；同时把「替换 Xboard + 白标多租户」的探索结论与 4 项拍板决策**定稿**为 `docs/方案/替换Xboard与白标多租户实施计划-v1.0.0.md`，并把冻结的独立 Mock 前台（`web`）从部署清单摘除。**不动任何业务代码**。

### 新增

- **`archive/` 归档区**（五分类：`root-tmp-2026-10` / `root-big-artifacts` / `legacy-dirs` / `logs-2026-10` / `tools-tmp-2026-10`）+ `archive/README.md` + `archive/_MOVE_LOG.md`：共归档 **347 项**，逐项登记「原路径 → 归档路径」，可回溯。
- **`tools/check-root-hygiene.js`（根目录整洁守护）**：断言 ① 根目录顶层 `_*` = 0；② 顶层文件 ≤ 70；③ `.dockerignore` 含 `archive`；④ `.gitignore` 含 `/archive/`；⑤ 关键文件（server.js / mysql-store.js / requirements-hcaptcha.txt / Dockerfile / deploy-manifest.json / VERSION.json / CHANGELOG.md / README.md）仍在根目录；⑥ 归档区 README 与移动日志存在。已挂 `package.json` 的 `hygiene:check` 与 `.githooks/pre-commit`。
- **`docs/方案/替换Xboard与白标多租户实施计划-v1.0.0.md`（正本）**：合并《白标独立站-多租户设计》与归档计划，含 4 阶段路线、数据模型、§五「上游多源 vs 多租户正交」澄清、各阶段用户故事与验收用例。
- **文档归位**：`docs/部署/DEPLOY.md`、`docs/部署/DEPLOY_GUIDE.md`、`docs/接口/对接API.md`（由根目录散落文件迁入）。

### 变更

- 根目录顶层文件 **138 → 59**、`_*` 临时文件 **72 → 0**；tools 顶层 **330 → 87**。
- `deploy-manifest.json` 摘掉 `kc-gpt-pay2-web` 容器与 `3001:3000` 端口；`docker-compose.yml` 的 `web` 服务加 `legacy-web` profile **默认停用**（磁盘 `web/` 目录保留可回滚）。
- `docs/00_项目状态.md` 头部 `v1.32.0` → `v1.37.0`；内核补丁「共 6 处」→「**共 9 项**」（P1 / P1b / P2 / P3 / P4 / P5+P6 / P7 / P8）。
- 旧方案稿《后台形态选型-自建vs改Xboard》《系统低耦合重整与上线路线》顶部标注「已被新稿重开」。
- `.gitignore` 加 `/archive/`；`.dockerignore` 加 `archive` / `web` / `logs` / `_bak_v114_promo` / `.trae` / `.workbuddy` / `.git_broken_backup`。

### 验证

- **门禁全绿（退出码 0）**：`node tools/check-docs-sync.js` / `node tools/check-currency.js` / `node tools/xboard-patch-check.js` / `node tools/check-root-hygiene.js`。
- **服务可用**：`curl -s http://localhost:3100/api/public/runtime` 返回 **200**。
- **用例**：US（根目录可读 / 归档不进镜像 / 可从 `_MOVE_LOG.md` 回溯）+ F1-F4 + U1-U3 **全通过**（实测：根目录顶层文件 59 ≤ 70、`_*` = 0、`docs/部署/DEPLOY_GUIDE.md` 可达、`archive/README.md` 含 5 分类说明、随机抽 3 项归档文件 3/3 在日志中命中）。

### 下一步

- **Stage 1（v1.38.0）地基**：`kc_api_clients` 扩 6 列 + 4 张租户表（`kc_tenant_domains` / `kc_tenant_brand` / `kc_tenant_catalog` / `kc_tenant_staff`）+ `resolveTenant` 中间件 + 技术后台「租户管理」页 + 补丁绿灯卡片 + 商品↔上游可视图。
- 已确认**「上游多源」与「多租户」正交**（每个商品可接不同上游，与租户维度无关），**上游路由为平台级能力、不对租户开放**（方案 §五）。

---

## v1.36.0 · 2026-10-15 · 登录前首页（游客落地页）与登录页改版：sukai 风格 IA + 自建登录/注册表单

**一句话概括**：按用户指令把**登录前首页**与**登录页**按 sukai.ai 的信息架构重写 —— 游客落地页由「Hero + 套餐卡 + 4 步流程 + FAQ」改为**「决策区 → 按需选服务 → 价格 → 两条路径 → 权益包推介 → 为什么选我们 → FAQ → 底部 CTA」**；登录页**弃用原生 Naive UI 登录卡弹层**，改为**完全自建的「登录 / 注册」双 Tab 表单**（`#kc-gl-modal`），直调 `/api/v1/passport/auth/{login,register}` 并自行写入令牌。**接口与注入机制不变**（仍是同一份 `custom_html`）。

### 新增

- **游客落地页新 IA（`tools/kc_theme_inject.html` · `HTML_GUEST` 重写）**：公告条 → Hero（主标题「ChatGPT 账号与套餐服务」+ 双 CTA「我没有账号，买成品号 / 我已有账号，办代充」+ 3 条信任标签）→ **决定区**（`kc-gd-decide`：01 没有账号 / 02 已有账号，两张卡各列 4~5 步）→ **按需选服务**（`kc-gd-need`，分类卡按 `GET /plan/kc-cards` 的 `categories` **数据驱动**渲染，空分类自动隐藏）→ **价格区**（保留原动态套餐卡）→ **两条路径**（`pathSection` 重写）→ **权益包推介**（`kc-gd-packs`，按 `packs` **数据驱动**，显示 `$xx.xx` 与「用 N 次权益」，空则隐藏）→ **为什么选我们** → **FAQ（4 → 6 条）** → 帮助条 → 页脚。**删除**旧 `.kc-portal-steps` 4 步区块。
- **游客顶栏锚点 4 项**：`首页(#kc-guest) / 服务(#kc-gd-need) / 权益包(#kc-gd-packs) / 常见问题(#kc-guest-faq)`。
- **自建登录层 `#kc-gl-modal`（`HTML_GUEST_LOGIN`）**：品牌头 + 「登录 / 注册」**双 Tab**（`data-gl-tab`）+ 邮箱/密码（注册加确认密码）+ 「我有邀请码」可展开邀请码（`data-gl-invite`）+ 错误行 `#kc-gl-err` + 原生 `<form id="kc-gl-form">`；**无忘记密码**（站点未配置发信，改为「请联系在线客服处理」）。
- **`fetchPlanConfig()` 补 `packs`**：`cfg.packs = d.packs || []`（原代码只取 `cards`，丢弃 `packs`）。
- **新增渲染函数**：`guestNeedDesc(key)` / `renderGuestNeedCategories()` / `renderGuestPacks()`。

### 变更

- **登录页弃用原生登录卡弹层**：删除 `brandLoginCard()`；CSS 遮罩规则替换为 `#kc-gl-modal { display: none }`；`body.kc-guest-on .wh-full.flex.items-center:not(#kc-gl-modal)` 显式排除自建层（继续用**类选择器**而非新 id，以抗 Vue 重渲染换掉原生元素）。
- **登录态写入与续接**：`guestLoginSubmit()` 校验后 `POST /api/v1/passport/auth/{login,register}`（注册态走 register），取 `data.auth_data || data.token` 并补 `Bearer ` 前缀，`localStorage.setItem('VUE_NAIVE_ACCESS_TOKEN', JSON.stringify({value: auth}))` → `location.reload()`。
- **意图续接扩展为三种（`ensureIntentResume()`）**：`{planId}`（原逻辑）/ `{cat}`（写 `sessionStorage.kc_plan_cat` 后落 `#/plan`，由商品页 `applyExpectedCategory()` 落到该分类）/ `{goto}`（直达该 hash，如 `#/pack`）；入口守卫放宽为 `planId || cat || goto`。新增事件分支 `guest-cat` / `guest-goto` / `guest-login-close`，`guest-login` 改为 `openLoginModal() + ensureIntentResume()`。
- **弹层交互接线**：点 `#kc-gl-modal` **自身空白**关闭；`Escape` 关闭；`[data-gl-tab]` 切 Tab；`[data-gl-invite]` 展开邀请码；`document` 级 `submit` → `guestLoginSubmit()`。`teardownGuest()` 一并移除 `kc-gl-modal`。
- **深色 token 选择器放宽为 `body.kc-dark`**（原 `body.kc-has-topbar.kc-dark`）：游客态无顶栏，改后**游客落地页也能跟随站点深色**；`ensureGuestLoop` 每轮 `detectDark()` 同步。
- **修缺陷：`ensureGuestLoop()` 改为幂等**。`tryBoot()` 对游客态**每 300ms** 调用一次 `ensureGuestLoop()`，而原实现每次都 `clearInterval` + 重建 600ms 定时器 → 定时器被无限推迟、**永不触发**（实测心跳恒为 0）。改为「已在跑就直接返回」，定时器方可正常心跳。
- **`tools/check-airport-lexicon.js` 同步**：登录输入框选择器 `.wh-full.flex.items-center input` → `#kc-gl-modal input`；Enter 改为带 `text:'\r'`（原生 `<form>` 隐式提交需 keypress）并加「点 `#kc-gl-submit`」兜底；「服务周期」断言由硬编码 `30 天` 改为**合法值域匹配**（单次/30/90/180/365/730/1095 天），以适配「最近订单」period 变化。

### 验证

- 新增 `tools/_v136_guest_verify.js`（验收脚本，**不入库**）**33/33 全绿**（截图 `logs/v136-guest/`）：
  - **F1 结构**：八区块齐备且自上而下有序；FAQ = 6；顶栏锚点 = 4。
  - **F2 自建表单登录**：弹层可见 → 填测试账号 → **Enter 提交**（非兜底点击）→ 令牌写入 → reload 后 `#kc-guest` 消失、`#kc-topbar` 出现。
  - **F3 注册**：切「注册」Tab → 邮箱/密码/确认密码/邀请码字段齐备 → 「我有邀请码」可展开 → 一次性邮箱注册即登录 → **测试用户已清理（残留 0）**。
  - **F4 分类意图续接**：点「我没有账号 · 买成品号」→ 写 `kc_gate={cat:'account'}` → 登录 → 落 `#/plan`、`kc_plan_cat=account`、**可见卡片无非 account 泄漏**（现场库内无 account 商品，故 hidden=1）。
  - **F5 文案**：无「会员/等级/升级/VIP」；权益包区含「用 N 次权益」；全页金额一律 `$`，无 `¥`/元/人民币。
  - **U1 响应式**：1440 与 480 均无横向溢出；need 区 **3 列 → 1 列**。**U2 弹层**：空白点击关闭 / Esc 关闭 / Tab 邮箱→密码。**U3 深色**：`body.kc-dark` 生效、Hero 文字浅色、卡片深色底、品牌色恒 `rgb(0,168,98)`；运行期 JS 错误 `[]`。
- 回归：`node tools/check-airport-lexicon.js` **17/19**（2 项 FAIL 均为**订单详情页**、**非本版本引入**，见下「已知问题」）。

### 已知问题（登记，非本版本引入）

- **订单详情页「旧订阅折抵金额」未被隐藏规则覆盖**：`KC_FF_RULES.rows` 已有 `{label:'旧订阅折抵金额', hide:true}`，但行隐藏的前置条件是「容器 `childElementCount === 2` 且标签以『：』结尾、长度 ≤16」，该行在当前渲染结构下**不满足前置条件**而漏网。**触发条件**：订单带 `surplus_amount`（旧订单剩余价值折抵），即**权益包兑换类订单**（Step 7 起产生）。故 `check-airport-lexicon.js` 的「详情·词典断言」命中「旧订阅折抵金额」（`订阅`/`折抵` 均为词典词）。**待用户决策是否本轮修复**。

### 下一步

- **待用户决策 · 订单详情页「旧订阅折抵金额」漏隐藏是否本轮修复**（修法二选一：放宽 `KC_FF_RULES` 行隐藏前置条件，或在 `kcFFRunRows()` 增加按 label 白名单隐藏分支）。
- **待用户决策（v1.35.0 遗留）**：首页门户与 `#/plan` 的权益报价基准口径是否需统一；v1.35.0 已把首页改为与商品页同源（同调 `POST /user/kc/quotes`），此项可能已随之消解，需复核确认。
- **整体验收（可选）**：请用户对前台改版 Step 0-9 全链路做整体走查（游客落地页 / 首页门户 / `#/plan` / `#/pack` / 我的订单 / 后台「权益报价」页）。
- **运营侧动作**：在后台「权益报价」页为各权益包录入逐商品一口价（单位：分；未配置 = 按原价）。

---

## v1.35.0 · 2026-10-15 · 权益报价：每商品单独报价 + 后台维护页 + 首页门户口径统一

**一句话概括**：按用户指令**废弃「统一折扣」**（规则级 `percent 40` 全程 6 折）—— 改为**每个商品单独报价**：「某权益包对某商品的一口价」由运营在后台新页「**权益报价**」逐包逐商品维护，**不同权益包对同一商品可报不同价**，**未配置的商品一律按原价**。同时把**首页门户与商品页的口径统一**到完全同源（同一个 `POST /user/kc/quotes`）。新增 1 张表 + 1 个后台页 + 2 个后台接口，插件与 Xboard 内核**零改动**（报价出参契约不变）。

### 新增

- **新表 `kc_entitlement_prices`（`mysql-store.js`，定价唯一事实源）**：`(rule_code, plan_code)` 唯一键 + `price_cents`（该权益包下该商品的一口价，**分**）+ `status` + `note`；建表常量 `ENTITLEMENT_PRICES_TABLE_SQL` + `ensureEntitlementPricesTable()` 接入 `ensureReady()`。**无种子数据**（初始留空，运营手填）。
- **后台接口（`server.js`，`requireSecondaryAuth`）**：
  - `GET /api/admin/entitlements/prices?rule_code=` → `{rule_code, packs[], products[{plan_code,name,list_price_cents,price_cents|null}]}`；
  - `POST /api/admin/entitlements/prices` → `{rule_code, items:[{plan_code, price_cents|null}]}`（`null`/空 → **删除该行** = 未配置 = 原价；有值 → `ON DUPLICATE KEY UPDATE`）；
  - 新 helper `entitlementListPriceCents()`：`v2_plan.prices` 存**主单位/美元**，按周期取首个 > 0 价 **×100** 得分（与前台 `planPriceCents()` 同口径）。
- **后台「权益报价」独立页（`public/admin.html`）**：导航新增入口（在「权益」之后）；选权益包下拉 → 列表逐商品填价（商品名 + **原价只读** + 报价输入 `step .01` + 清除按钮）+ 加载/保存；说明文案「未填写的商品 = 该权益包对它不优惠（按原价）」；保存仅提交变动项。

### 变更

- **KC 定价引擎改为「逐商品查表」**（`server.js`）：新增 `loadEntitlementPrices(ruleCodes)`（一次查询建索引）与 `pickBestEntitlementPrice(grants, priceIndex, baseCents, planCode, now)` —— 保留过期/次数用尽校验，**删除** `min_order_cents`/`plan_scope`/`discount_type` 分支；命中且 `< baseCents` 才为候选、多权益取**最低价**、**未命中即不优惠**。`bestGrantFor()` 被其取代（旧函数名不再存在）；`POST /api/integration/entitlement/quote` 与 `priceQuote()` 的权益分支**共用同一 helper**（消除两套引擎的口径漂移）。`entitlementActiveGrants()` 精简为只取 `g.id/g.rule_code/g.remaining_uses/g.expires_at` + `r.status` JOIN 过滤。
- **首页门户改为与商品页完全同源**（`tools/kc_home_portal.html`）：新增 `QUOTES`/`LAST_FETCH` + `buildItems()` + `fetchQuotes()`（POST `/user/kc/quotes`，4s 节流）；`buildModel()` 重写为「仅当 `applied_source==='entitlement' && final>0 && final<base` 才显示权益价」，**删除 `market` 字段、不再读 `cfg.plans` 的 `quotaPrice/marketPrice`**；`heroHtml` 删 `marketLine`；无权益卡片文案改为「开通权益包，解锁权益价」。
- **规则表降级为元数据**：`kc_entitlement_rules` 的折扣字段（`discount_type`/`discount_value`/`plan_scope`/`min_order_cents`）**保留不动，但不再参与定价**（后台「权益」页规则表单不改）；后台「站点与定价」的商品权益价面板保留不删，加提示「该面板已不再影响前台展示」。

### 验证

- `node tools/_v135_pricing_verify.js` **24/24 全绿**（截图 `logs/v135-pricing/2026-10-15T03-49-15-871Z/`）：
  - **F1 后台可维护**：GET 返回启用权益包 + 商品列表（`xplan_1` 原价 **1500 分 = $15.00**）；写 `$9.00` → 回读 900 分；置空 → `cleared=1` 且 DB `COUNT=0`。
  - **F2 不同权益包不同报价**：同一商品 `xplan_1`，持 `pack_light_off40` → **900 分**、持 `pack_pro_off40` → **750 分**（互不相同）。
  - **F3 未配置 = 原价**：未配 `xplan_2` → `applied_source='none'`、`final_cents=1500`（不优惠）。
  - **F4 端到端结算**：有权益下单 → `v2_order` 应付合计（`total_amount+balance_amount+surplus_amount`）= **900 分**（非 1500）；取消后余额恢复 `20000`；KC `quote→consume→refund` 使 grant `5 → 4 → 5`。
  - **U1 口径同源**：首页 `.hp-good` 与 `#/plan` `.kcdp-has` 的「权益价|句式」集合**完全一致**（均为 `$9.00 | 用 1 次权益 · 省 $6.00`）。
  - **U2** 深色下 `.kcdp-num` 恒 `rgb(0,168,98)`；窄屏 480px 无横向溢出（delta=0）。**U3** 句式统一 + 零禁词（会员/等级/升级/VIP）。运行期 JS 错误 `[]`。
- 测试后状态已复原（`balance=20000`、`grant remaining=5`、`kc_entitlement_prices` 行数 = 0、测试订单已取消、测试快照/流水已删）。
- `node tools/check-docs-sync.js` 与 `node tools/check-currency.js` 通过。

### 影响与风险

- **旧断言已过期（有意为之）**：Step 7 的 `tools/_v134_settle_verify.js` 中「6 折 `$9.00`」类期望值随「统一折扣」一起作废 —— 现口径下**未配置即原价**，Step 8 起验证以 `tools/_v135_pricing_verify.js` 为准；首页「`$12.00`/省 `$8.00`」旧断言同步作废。
- **运营动作项**：`kc_entitlement_prices` 初始为空，**上线后所有人只看到原价**（属正常，不是"没生效"）；需运营在后台「权益报价」页逐包逐商品录入一口价。报价单位是**分**（`$9.00` 填 `900`）。
- **部署与回滚**：KC 改动 `docker restart kc-gpt-pay2-app`；`admin.html` 随容器 bind-mount 生效；前台 `node tools/xboard-apply-custom-html.js`（custom_html 380131 → 382232 字符）。回滚见 `docs/改版进度.md`「四 / Step 8 / 如何回滚」。

### 下一步

- **整体验收（可选）**：请用户对 Step 0-8 全链路做整体走查（首页门户 / `#/plan` / `#/pack` / 我的订单 / 后台「权益报价」页）。
- 运营侧：按需录入各权益包的逐商品一口价（空表 = 全按原价）。
- 其余（非本版本范围）：移动端 ≤480px 首屏排布打磨、深色模式手动开关。
- 明细见 `docs/改版进度.md`「二、下一步 / Step 9」与「四 / Step 8」。

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
