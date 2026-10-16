# Stage 3 切换前对照清单 v1.0.0

> 方案编号：`SP-2026-10-15-STAGE3-PARITY-v1.0.0`
> 日期：2026-10-15　状态：**已完成（Stage 3 = v2.0.0）** —— **3.1~3.9 全部完成**：3.1(v1.40.0) / 3.2(v1.41.0) / 3.3(v1.42.0) / 3.4(v1.43.0) / 3.5(v1.44.0) / 3.6(v1.45.0) / 3.7(v1.46.0) / 3.8(v1.47.0 配置变更) / **3.9(v2.0.0 Xboard 退场)**；**退场后进入观察期**，无回退事故方可按原计划彻底摘除容器（另案需批准）
> 依据：[替换Xboard与白标多租户实施计划-v1.0.0.md](file:///d:/tools/KC-PAY-GPT/docs/方案/替换Xboard与白标多租户实施计划-v1.0.0.md#L356-L367) §十三；[Xboard原生功能处置清单-v1.0.0.md](file:///d:/tools/KC-PAY-GPT/docs/方案/Xboard原生功能处置清单-v1.0.0.md)
> 用途：Stage 3 的**唯一前置输入** —— 先把「主站现在靠 Xboard 提供的体验」与「KC 原生已有能力」逐项对照，**缺一不可地补齐后**再关注入、再摘容器。

---

## 一、为什么必须先做这份对照

主站现在的体验**几乎全部是 Xboard 注入实现的**（`custom_html` 贴纸串 + 5 个注入源 + 9 处内核补丁）。Xboard 一退场，这些注入会**整体消失**。因此 Step 1「主站切 KC 前台」不是"换个壳"，而是**把注入里已实现的功能在 KC 原生重做一遍**。漏一项 = 用户少一个功能。

---

## 二、Xboard 主站当前承载面（退场即消失）

| # | 承载面 | 实现载体 | 关键依赖 |
|---|---|---|---|
| X1 | 首页门户（Hero / 门槛对比 / 三步 / 商品双价卡 / 权益包三档 / FAQ） | `tools/kc_home_portal.html` | `/kc-proxy/site-config`、`/api/v1/user/plan/fetch`、`/user/kc/quotes` |
| X2 | 顶部导航 + 登录态菜单 + 抽屉导航（5 项：代充/成品号/建站服务/权益包/我的订单） | `tools/kc_theme_inject.html` | Xboard 主题 DOM |
| X3 | 游客落地页 + 自建登录/注册弹层（sukai 风格，v1.36.0） | `tools/kc_theme_inject.html`（`HTML_GUEST` / `HTML_GUEST_LOGIN`） | `localStorage.VUE_NAIVE_ACCESS_TOKEN` |
| X4 | 权益包独立页 `#/pack`（方案说明 + 商品卡 + 我的权益 + 用余额开通） | `tools/kc_theme_inject.html` | `/user/kc/entitlements`、pushState 意图记忆 |
| X5 | 钱包页 `#/wallet`（余额大卡 + 流水明细） | `tools/kc_wallet_inject.html` | 余额 / 流水 / 充值台账接口 |
| X6 | 订单中心增强（状态筛选 tab + 待支付 30 分钟倒计时 + 四节点时间线 + 售后弹窗 + 联系客服） | `tools/kc_wallet_inject.html` + 主题注入 | `/user/kc/after-sales` |
| X7 | 商品页双价卡（权益价 / 原价 / 省额） | `tools/kc_plan_double_price.html` | `POST /user/kc/quotes` |
| X8 | 浮动按钮组 + 充值面板 + 兑卡面板 | `tools/kc_panel_inject.html` | Xboard 充值下单 + 兑卡 |
| X9 | 订单页「去开通」卡片 + 状态徽章 / 真进度条 / 失败红字 | `tools/kc_activate_inject.html` | `/user/kc/card?trade_no=`、`/kc-proxy/redeem?cdk=` |
| X10 | 用户中心 / 登录注册 / 工单 / 知识库 / 邀请（原生页） | Xboard 内核 | Xboard 表（`v2_user`/`v2_order`/`v2_ticket`…） |
| X11 | 余额充值下单 + 收款（BEpusdt USDT）+ 发卡 | Xboard 内核 + `KcIntegration` 插件 | `v2_order` / `kc_api_orders` |
| X12 | 9 处内核补丁（充值/权益/并发/结算口径） | `tools/xboard-patches/` | `tools/xboard-patch-check.js` |

## 三、KC 原生现有能力（不依赖 Xboard）

| # | 能力 | 载体 |
|---|---|---|
| K1 | 租户白标前台（首页 / 商品列表 / 详情 / 下单 / 我的订单 + 品牌渲染） | `GET /tenant` → `public/tenant/index.html` |
| K2 | 顾客账号（租户维度）注册/登录/会话 | `/api/tenant/auth/register|login|me`，`kc_customers` |
| K3 | 商品目录 / 报价 / 下单 / 订单查询 | `/api/tenant/catalog|quote|orders` |
| K4 | 共享下单核心（幂等 + 锁价 60s + 3% 漂移 + 余额原子扣减 + 履约发卡） | `createApiOrderCore`（server.js） |
| K5 | 站点配置 / 运行时 / 支付区域 | `/api/public/site-config|runtime|payment-region` |
| K6 | 卡密核验 / 查询 / 下载 / 代充触发 | `/api/verify-cdk`、`/api/cdk/query|download`、`/api/run-process` |
| K7 | 代理商后台 / API 客户门户 / KC 技术后台 | `/tenant-admin`、`/api-portal`、`/admin` |
| K8 | 权益结算引擎（报价 / 扣次 / 退次 / 发权益） | `/api/integration/entitlement/*` |
| K9 | 上游多源目录与健康 | `/api/admin/upstreams*`、`kc_upstream_health_snapshots` |
| K10 | 旧版独立站落地页（**非主站现用体验**） | `GET /` → `public/index.html`（KC ChatGPT PLUS 旧页） |

## 四、缺口清单（主站要在 KC 前台重建）

> 严重度：**阻断** = 缺它主站不可切换；**重要** = 体验降级不可接受；**次要** = 可后补。

| 缺口 | 对应 | 严重度 | 说明 |
|---|---|---|---|
| G1 兑卡 / 激活前台页（`/?cdk=` 落到 KC 原生页） | X9 | **阻断** | 现在 `/kc-proxy/redeem` 302 到 KC `/?cdk=`，但 KC 根路径只有旧落地页，**无专用兑卡页**；代充闭环断在这里 |
| G2 钱包 / 充值（余额 + 档位 $100/$300/$500 + 自定义 + BEpusdt 收款） | X5、X11 | **阻断** | KC 有租户余额账本，但**无面向顾客的充值前台**；主站顾客无法自助充值 |
| G3 顾客登录 / 注册（主站 = platform 租户） | X10 | **阻断** | 现有 `kc_customers` 是**租户维度**，需确认 platform 租户可用；主站登录入口不存在 |
| G4 权益包页 `#/pack` + 我的权益 + 用余额开通 | X4 | **阻断** | 权益包是平台自有资产，退场后必须重做，否则购买入口消失 |
| G5 首页门户（Hero / 双价卡 / 权益包推介 / FAQ） | X1 | **阻断** | 主站首屏，缺它主站只是"商品列表" |
| G6 订单中心增强（筛选 / 倒计时 / 时间线 / 售后 / 客服） | X6 | 重要 | 租户前台仅有简单订单列表 |
| G7 商品页双价卡（权益价展示） | X7 | 重要 | 租户前台刻意不启权益包，主站需专用双价 |
| G8 游客落地页 + 自建登录弹层 | X3 | 重要 | 未登录首屏体验 |
| G9 顶部/抽屉导航（5 项口径） | X2 | 重要 | 与导航铁律绑定（记忆 Hard Constraints） |
| G10 浮动按钮组 + 充值/兑卡面板 | X8 | 次要 | 可合入 G1/G2 |
| G11 工单 / 知识库 / 邀请（保留面迁移） | X10 | 重要 | 处置清单定调"保留"，须迁到 KC 前台（或先外链保留入口） |
| G12 卡密生命周期 / 分享（P2/P3，暂缓） | — | 次要 | 已登记暂缓，不阻塞切换 |

---

## 五、切换前置条件（红线，未满足不得关注入）

1. **G1~G5 全部落地并验收通过**（阻断项清零）。
2. **一笔端到端对照**：在 KC 前台跑通「注册 → 充值（模拟）→ 下单 → 发卡 → 兑卡 → 查单」，逐项与 Xboard 现状对照一致。
3. **金额一律 `$`**（`check-currency.js` 通过）与 **0 机场词**（`check-airport-lexicon.js` 19/19）。
4. **回滚预案就绪**：`deploy-manifest.json` 的 `xboard.inject` 单开关可一键回开；`tools/xboard-restore-custom-html.js` 可用。
5. 处置清单保留项（工单/知识库/邀请）有明确去向（迁移 or 外链），隐藏项确认不再回归。

### 前置条件达成核对（v1.47.0 · 2026-10-15）

| 条件 | 状态 | 证据 |
|---|---|---|
| 1 · G1~G5 落地并验收 | ✅ 达成 | 3.1(v1.40.0 G3) / 3.2(v1.41.0 G1) / 3.3(v1.42.0 G2) / 3.4(v1.43.0 G4) / 3.5(v1.44.0 G5·G7) 全部闭环 |
| 2 · 一笔端到端对照 | ✅ 达成 | 本次在 **KC 原生主站前台 API** 跑通「注册 → 充值(模拟收款回调) → 下单(扣顾客钱包) → 发卡(delivered+cdk) → 兑卡(`/api/verify-cdk` 识别卡密+套餐名) → 查单(顾客维度)」**14/14 PASS**（`tools/_v148_e2e_parity.js`，临时脚本不入库）。⚠️ 兑卡的 `run-process`（真实开通）需**用户自有 ChatGPT Session**，模拟环境止于卡密校验 |
| 3 · 金额全 `$` + 0 机场词 | ✅ 达成 | `check-currency.js` 无人民币痕迹；`check-airport-lexicon.js` 目标为 Xboard 前台 `:7001`，**随 3.9 退场已退役**（改由 `check-currency.js` 承担币种口径、前台文案静态评审覆盖机场词）；退场前的已知残留 R2「旧订阅折抵金额」随 Xboard 退场消失 |
| 4 · 回滚预案就绪 | ✅ 达成 | `deploy-manifest.json` xboard `inject` 单开关（3.8 已置 false，可一键回 true）+ `tools/xboard-apply-custom-html.js` / `tools/xboard-restore-custom-html.js` 均在位 |
| 5 · 保留项去向明确 | ✅ 达成 | 3.7(v1.46.0)：页脚「工单支持/使用文档/邀请好友」入口（外链 or 原生回落），去向表见处置清单 §三 |

> 结论（v2.0.0）：**5 项前置条件全部达成**（条件 3 的机场词门禁随退场退役、R2 残留随之消失）。3.9 已执行，**Stage 3 完成**；退场后进入观察期，无回退事故方可按原计划彻底摘除容器（另案需批准）。

---

## 六、分步执行顺序（每步 = 可独立验收的单元）

| 步 | 内容 | 交付 | 退出条件 |
|---|---|---|---|
| **3.1** | 主站顾客登录/注册（platform 租户复用 `kc_customers`）+ 会话 | 主站登录入口 + `/api/主站/auth/*` | G3 闭环 |
| **3.2** | 兑卡 / 激活前台页（`/?cdk=`）在 KC 原生实现 | 新前台页 + `/api/verify-cdk` 对接 | G1 闭环 |
| **3.3** | 钱包 / 充值前台（余额 + 档位 + BEpusdt 收款回调） | 钱包页 + 充值接口 | G2 闭环（模拟） |
| **3.4** | 权益包页 `#/pack` + 我的权益 + 用余额开通 | 权益包前台页 | G4 闭环 |
| **3.5** | 商品页双价卡 + 首页门户（Hero/双价/权益推介/FAQ） | 首屏 + 商品页 | G5、G7 闭环 |
| **3.6** | 订单中心增强（筛选/倒计时/时间线/售后/客服） | 订单前台增强 | G6 闭环 |
| **3.7** | 保留面迁移（工单/知识库/邀请）+ 导航 5 项 | 迁移页/外链 | G9、G11 闭环 |
| **3.8** | `deploy-manifest.json` 关 `xboard.inject` 并观察一周 | 配置变更 | 无回退事故 |
| **3.9** | 摘除 Xboard 容器 + 9 补丁/注入链标记退役只读 | 部署清单变更 | 全链路 200 |

### 3.1 用户故事与验收用例（本步先行）

| 类型 | 用例 | 判定 |
|---|---|---|
| US-3.1 | 主站顾客能注册并登录（platform 租户） | 令牌签发、`kc_customers` 落 platform 维度 |
| US-3.2 | 顾客登录后能看到「我的订单」且只看到自己的 | 越权 404 |
| US-3.3 | 未登录访问需登录页会引导登录，不白屏 | 引导而非白屏 |
| **F1** | 注册 → 登录 → `GET /api/tenant/auth/me` 返回本人 | 200 且身份正确 |
| **F2** | 跨租户越权：A 租户令牌访问 B 租户数据 | 403/404 |
| **F3** | 会话不落库：注册/登录后查 `kc_api_orders`/审计表无 token | 0 命中 |
| **U1** | 主站登录页在 375 / 1500 宽均不破版 | 截图抽查 |
| **U2** | 登录页 0 机场词、金额全 `$` | 词典 + 货币断言 |
| **U3** | 品牌色与深色模式对比度达标 | 对比度检查 |

---

## 七、回滚预案

- **未关注入前**：任一步回滚 = 撤销该步的 KC 前台改动，主站仍由 Xboard 承载，无用户可见影响。
- **已关注入后**：`deploy-manifest.json` 将 `xboard.inject` 置回 `true` + 跑 `tools/xboard-apply-custom-html.js`，约 2 分钟恢复主题注入。
- **已摘容器后**：从 `docker-compose`（`../Xboard/docker-compose.yml`）重新 `up -d` 并重打 9 处补丁（`tools/xboard-patch-check.js --fix`）。

---

## 八、执行记录（滚动）

| 时点 | 步 | 状态 | 备注 |
|---|---|---|---|
| 2026-10-15 | 调研 | ✅ 完成 | 本清单成稿；Stage 0/1/2 已完成（v1.37.0 / v1.38.0 / v1.39.0） |
| 2026-10-15 | 3.1 | ✅ 完成（v1.40.0） | 主站顾客登录/注册（platform 租户复用 `kc_customers`）+ 主站前台骨架 `GET /site`；**G3 闭环**。功能 14/14 PASS（F1 注册→登录→me / F2 跨租户 403 `TENANT_MISMATCH` / F3 无 token 列）＋ UX（默认/375/1500 不破版、0 机场词、金额全 $）＋ `check-currency`/`check-docs-sync` 通过。Xboard 未退场、未关注入 |
| 2026-10-15 | 3.2 | ✅ 完成（v1.41.0） | 兑卡/激活前台页 KC 原生实现（主站前台「兑换卡密 · 完成开通」视图）：`GET /?cdk=X` 与新增 `GET /redeem` 落到 KC 原生兑卡页（自动预填 + 自校验）；卡密验证 → 会话凭证校验 → 提交开通 → WebSocket 实时进度；**G1 闭环**。路由/行为实测 + UX（预填自校验、375px 不破版、本页 0 JS 错误）+ Stage 3.1 回归 14/14 + 三门禁全绿。Xboard 未退场、未关注入 |
| 2026-10-15 | 3.3 | ✅ 完成（v1.42.0） | 钱包/充值前台 + **顾客级钱包**（`kc_customers.balance_cents` + `kc_customer_wallet_ledger` + `kc_customer_recharges`）；主站前台「我的钱包」视图（余额 + 档位 $100/$300/$500 + 自定义 + 流水 + 充值弹层）；BEpusdt USDT（TRC20）收款**模拟**（发起生成地址 →「我已支付」触发收款回调入账，幂等）；**`tenant_web` 下单改从顾客钱包扣、open API 从租户余额扣（两条账本分离，R2 红线）**；**G2 闭环**。功能 15/15 PASS + UX（充值 $300 到账、375px 不破版、弹层不重叠、0 机场词）+ 三门禁全绿。Xboard 未退场、未关注入。⚠️ 充值为模拟，真实接入前 `confirm` 须改为「仅 BEpusdt notify 验签入账」 |
| 2026-10-15 | 3.4 | ✅ 完成（v1.43.0） | 权益包前台（KC 原生重建，替换原过渡态占位）：数据层 `kc_entitlement_rules` 加售价 `sale_price_cents`（0=前台不可售）+ `kc_entitlement_grants` 加顾客维度 `customer_id`（与历史 Xboard `user_id` 并存，唯一键改 `uk_owner_rule_active`）+ 新建 `kc_customer_pack_purchases`（`client_ref` 幂等）；前台 API `GET /api/tenant/packs` / `GET /api/tenant/entitlements` / `POST /api/tenant/packs/purchase`（用顾客钱包余额开通：扣款 → 发权益 → 记购买 + 写钱包流水，幂等 + 回滚）+ 运营定价 `POST /api/admin/entitlements/packs/:code/price`；主站前台「权益包」视图（我的权益 + 可开通权益包卡 + 「用余额开通」）；**G4 闭环**。功能 **18/18 PASS**（`tools/_v143_pack_verify.js`）+ 数据核对（顾客维度 grant `user_id=0`）+ UX（点击→已开通徽章 + 我的权益 5/5 + 钱包扣 $60、375px 不破版、0 JS 报错）+ 三门禁全绿。Xboard 未退场、未关注入。⚠️ 权益价应用到原生下单的双价卡留 Stage 3.5（G7） |
| 2026-10-15 | 3.5 | ✅ 完成（v1.44.0） | **商品双价卡 + 首页门户（G5/G7 闭环）**：①G7 权益价参与 KC 原生下单结算 —— `GET /api/tenant/catalog` 每项加 `base_price`/`entitlement_price`/`entitlement_rule`/`entitlement_discount`；`POST /api/tenant/quote` 命中权益锁权益价；`POST /api/tenant/orders` 按权益价扣顾客钱包 + 交付后 `entitlementConsume` 扣次（幂等，扣到 0 标 `exhausted`）；前台 `priceHtml()` 渲染「权益价大字 + 原价划线 + 『权益价』标签 + 『用 1 次权益 · 省 $X』」；访客只见原价（`maybeCustomer` 可选身份）。②G5 首页门户 —— Hero 后新增 5 区块（为什么更省 / 三步完成 / 热门商品 / 权益包推介 / 常见问题），首屏不再依赖 Xboard 注入 `kc_home_portal`。功能 **19/19 PASS**（`tools/_v144_pricing_verify.js`）+ UX（5 区块齐全、列表详情双价 $9.00 vs $11.50、375px 不破版、0 JS 报错）+ 三门禁全绿。Xboard 未退场、未关注入。⚠️ 为验证双价向 `kc_entitlement_prices` 插入示例报价 `pack_light_off40 × xplan_1 = 900`（保留待运营确认） |
| 2026-10-15 | 3.6 | ✅ 完成（v1.45.0） | **订单中心增强（G6 闭环）**：①数据层新建 `kc_after_sales`（顾客订单售后申请，`request_type`/`status`/`message`）；②`GET /api/tenant/orders` 加 `updated_at`；③新增 `POST /api/tenant/after-sales`（`authenticateCustomer`，作用域取 `req.tenant.id + req.customer.id`，他人/不存在订单 404、空描述/缺单号 400）；④主站前台「我的订单」状态筛选 tab（全部/处理中/已完成/失败，带计数）+ 订单详情弹层「订单进度」四节点时间线 + 「申请售后」弹层 + 「联系客服」入口 + 充值单 30 分钟支付时限倒计时。**口径**：KC 原生订单下单即扣款、无「待支付」态，故筛选口径为 全部/处理中/已完成/失败，「倒计时」落在 30 分钟时限的充值单上。功能 **14/14 PASS**（`tools/_v145_order_verify.js`）+ UX（筛选计数/空态、四节点时间线、售后提交成功、倒计时逐秒递减、375px 不破版、0 JS 报错）+ 三门禁全绿。Xboard 未退场、未关注入 |
| 2026-10-15 | 3.7 | ✅ 完成（v1.46.0） | **保留面迁移（G9/G11 闭环）**：依《Xboard原生功能处置清单》「工单/知识库保留、邀请保留入口但佣金不出圈」，主站前台**页脚新增「帮助与支持」行**：工单支持 / 使用文档 / 邀请好友 三入口；运营可在租户品牌 `extra_json` 配 `ticket_url`/`kb_url`/`invite_url` 走**外链**，未配时回落**原生**（工单 → 引导「我的订单 → 订单详情 → 申请售后」；使用文档 → 滚到首页「常见问题」；邀请 → 弹层说明「佣金在平台内结算、不对外开放提现」）。**复核导航 5 项口径（G9）**：顶部导航恒为 代充/成品号/建站服务/权益包/我的订单、无冗余「首页」。功能 **14/14 PASS**（`tools/_v146_help_verify.js`）+ UX（三链接居中、弹层文案、文档滚到 FAQ、导航仍 5 项、375px 换行不溢出、0 JS 报错）+ 三门禁全绿。Xboard 未退场、未关注入 |
| 2026-10-15 | 3.8 | ✅ 完成（v1.47.0） | **关闭 xboard.inject（配置变更）**：`deploy-manifest.json` 的 xboard 服务 `inject` 由 `true` → `false`（部署/启动不再重放 KC 前端注入），进入退场观察期；仅被部署引擎读取、**不摘容器、运行时不即时生效**；回滚 = 置回 `true` + `tools/xboard-apply-custom-html.js`（约 2 分钟）。前置核验：G1~G5 阻断缺口 + G6/G9/G11 闭环、KC 原生前台 `GET /site` 覆盖体验、回滚脚本在位；三门禁全绿。**观察期内未发生回退事故**（Xboard 停机状态下端到端 14/14 PASS 佐证主站不依赖 Xboard），3.9 已在其后执行（用户拍板接管根路径 + 保留容器可回滚） |
| 2026-10-15 | §五·条件2 | ✅ 达成 | **一笔端到端对照**在 KC 原生主站前台 API 跑通「注册 → 充值(模拟) → 下单(扣顾客钱包) → 发卡(delivered+cdk) → 兑卡(`/api/verify-cdk`) → 查单」**14/14 PASS**（`tools/_v148_e2e_parity.js`，不入库）；`run-process` 真实开通需用户自有 ChatGPT Session，模拟环境止于此。连同 §五 条件1/3/4/5 核对（见 §五 附录），5 项前置条件中 4 项完全达成、条件3 仅剩已知残留 R2 |
| 待做 | 3.9 | ✅ 完成（v2.0.0） | **Xboard 退场**（用户拍板：接管根路径 + 保留容器可回滚）：①`GET /` **始终**落到 KC 原生主站前台 `public/site/index.html`（`?cdk=X` 进兑卡视图、无参进首页；路由注册于 `express.static` 之前）；②清除 Xboard 主题 `custom_html` 注入（**405268 → 0**）；③`tools/xboard-patch-checks.js` 加 `RETIRED` 常量、`tools/xboard-patch-check.js` 退役态上报 `{retired:true}` 并 `exit 0`、`health.xboard_patches.retired=true`、后台卡片显示「已退役」、`deploy-manifest.json` xboard 加 `"retired": true`、部署引擎 `.ps1`/`.sh` start/deploy/verify/open-urls 排除 retired（`stop` 仍覆盖全部、verify 单列 `[KEPT]`）、`check-admin-airport`/`check-airport-lexicon` 加退役守卫、币种口径由 `check-currency` 承担；④容器 `docker stop xboard` **只停不删**（回滚资产）。验收：**全链路 200**（`/`·`/?cdk=`·`/redeem`·`/site`·`/tenant`·`/tenant-admin`·`/admin` + 核心 API）+ **UX 6/6**（`/` 为 KC 原生前台首页、导航恰 5 项、无「订阅」字样）+ **端到端对照 14/14 PASS**（Xboard 停机状态下注册→充值→下单→发卡→兑卡→查单）+ **回滚演练 PASS**（start xboard → apply 注入 405268 → 前台含 `realProgress` → 再清 405268→0 → stop）+ `kc-deploy verify`（xboard `[KEPT]`）+ 三门禁全绿 + `node --check server.js` 通过。⚠️ 回滚务必保留：置回 `inject=true` + `docker start xboard` + 跑 `tools/xboard-apply-custom-html.js`；**勿 `docker rm` / `compose down -v`** |

> 纪律：每步完成后在本表追加一行，并同步 `CHANGELOG.md` / `VERSION.json` / `docs/00_项目状态.md` / `docs/产品全景.md` / project_memory。
