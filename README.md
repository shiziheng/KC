# KC GPT 自动充值系统

<!-- ==================== 开发协作入口 ==================== -->
<!-- 任何 AI 助手 / 新开发者 / 新会话：开工前请按顺序读完本区块，不要跳过 -->

## 🤖 开发协作入口（AI 与新成员必读）

> **如果你只读一段话，就读这段。** 本区块是项目的唯一权威入口，代码和文档的现状都以此处为准。

### 1. 当前版本

**`v2.17.1` · 2026-10-18 · 前台弹层生命周期收口：修「购买卡密弹层压住兑换页」+「后开的弹层被先开的盖住」**

### 1b. 产品一句话

ChatGPT Plus / Pro 自动代充平台。主站前台由 **KC 原生前台**（`GET /`）承载，独立业务前台和后台仅运行 Mock：用户浏览后台配置的商品、创建自己的模拟订单、推进模拟支付/履约、提交售后留言并查看凭证。
由 KC 引擎、KC 原生主站前台、BEpusdt 收款网关和独立业务后台组成。**主站前台不会保存 ChatGPT Session 或调用 ZovoCard。**
功能清单、业务流程、未来规划详见 [`docs/产品全景.md`](docs/产品全景.md)。

> **当前交付边界**：主站 `GET /` 为 **KC 原生前台**；**Xboard 已退场（v2.0.0）且**网站已做**代码级摘除（v2.1.0）** —— `server.js`/`public/**`/`business/**` 均 **0 处 Xboard 引用**，商品/站点配置主数据已迁入 `kc_plans`/`kc_settings`/`kc_listing_cards`，业务模块不再直连旧系统；**Xboard 容器仍 `docker stop` 只停不删、保留可回滚**（`custom_html` 注入已清、9 补丁/注入链与 24 个 Xboard 时代工具已加退役标记）。独立业务后台入口为 `http://localhost:3100/business-admin`。独立 Mock 用户前台（`kc-gpt-pay2-web`，`:3001`）已于 **v1.37.0 从部署清单摘除并默认停用**（`docker-compose` 加 `legacy-web` profile，磁盘目录保留可回滚）。`/admin` 保持现有 KC 技术后台不变。**回滚到 Xboard 承载主站**：置回 `inject=true` + `docker start xboard` + 跑 `tools/xboard-apply-custom-html.js`（**切勿 `docker rm xboard`**）。真实支付、ZovoCard 和履约调用均关闭。

### 2. 强制阅读顺序（缺一不可）

| 顺序 | 文件 | 读它拿什么 |
|---|---|---|
| 1 | **本区块** | 最新版本号、当前进度、下一步 |
| 2 | [`docs/产品全景.md`](docs/产品全景.md) | **系统现在有什么功能、用户怎么用、未来做什么** |
| 3 | [`CHANGELOG.md`](CHANGELOG.md) —— **只读顶部第一个版本条目** | 最近做了什么、为什么这么做 |
| 4 | [`docs/00_项目状态.md`](docs/00_项目状态.md) | 运行环境、部署方式、待办、关键文件索引 |
| 5 | [`docs/开发规范.md`](docs/开发规范.md) | 动手前的强制规则（含不可变约束） |
| 6 | `.workbuddy/memory/MEMORY.md` | 长期踩坑与架构决策 |

> **两个关键约定：**
> ① `docs/产品全景.md` 是**产品能力与边界的唯一正本**（功能、业务流程、未来规划）。散落的 FEAT 文档与它冲突时，**以它为准**。
> ② `CHANGELOG.md` 的第一个版本条目永远是最新的，**不需要搜索或翻历史**，读顶部即可。

### 3. 当前进度

- **前台弹层生命周期收口（v2.17.1）**：按用户上报缺陷「购买卡密弹层点『去兑换』后，页面已切到兑换卡密，但购买卡密弹层仍压在最前面遮住新页面」—— ①**根因**：`go(view)` 切页从不收弹层；且全站 `.modal` 的 z-index **同为 100**，同值时按 **DOM 顺序**绘制，`#ckModal`（DOM 在后）会把它内部唤起的 `#rcModal`/`#authModal` 反过来盖住；②**修复**：新增 `openModal(id)`（登记 z-index 堆叠，后开的弹层必压前一个）与 `closeAllModals()`（收 8 个业务弹层 + 停充值倒计时/轮询），**`go(view)` 首行收弹层**，全站弹层展示统一走 `openModal()`（`#fpModal` 强制首密闸门除外）；③**同类排查**：主站前台共 **4 处**（购买卡密「去兑换」留遮罩 ← 上报；订单详情卡密单「去兑换」留遮罩；购买卡密「去充值」→ 充值弹层被盖住；购买卡密 401 唤起登录 → 登录弹层被盖住），其余前台（租户白标站 / api-portal / 旧落地页）**0 处**；④**回流补充**：购买卡密弹层「去充值」到账后自动调 `ckRefreshBill()` 刷新账单（「还差」消失、恢复可购买），关掉充值弹层即可继续购买；⑤**测试基建**：新增 `tools/_v2190_modal_layer_verify.js`（9 用例 / 16 断言：功能 F1~F5 + 体验 U1~U3，含源码守卫与 `elementFromPoint` 命中测试，截图 `logs/v2190-modal-layer/`）**16 PASS / 0 FAIL**；回归代充双轨 `_v2170` **22 PASS / 0 FAIL**；三门禁全绿。**未 git commit。**
- **代充双轨：直接代充（冻结模型）+ 卡密代充（N 卡）（v2.17.0）**：按用户指令把「平台直接代充」与「CDK 代充」彻底分成两条逻辑 —— ①**直接代充**＝顾客输入 Session 下单 → **冻结订单金额**（`kc_customers.held_cents`；`balance_cents` 收敛为「可用余额」）→ 平台向上游发起开通 → **成功才扣款（capture）、失败即解冻（release）**，超时未启动由周期对账自动解冻（`ACTIVATION_HOLD_UNSTARTED_TIMEOUT_MS` 默认 30 分钟）；②**卡密代充**＝顾客选数量下单 → **立即扣款 + 发 N 张卡密凭证**（`issueCdkByRef(ourOrderNo#1..#N)` → `cdk_list_json`），订单即刻完成，顾客之后随时在「兑换卡密」页输入卡密 + Session 完成开通；③**铁律：KC 原生 CDK 发放/兑换核心一字未改**，改动只在自有订单层（`kc_api_orders` 加 `fulfill_mode`/`hold_cents`/`cdk_list_json`、`kc_customers` 加 `held_cents`、钱包流水扩 `hold/capture/release`）。前端：代充详情页**二选一入口**（⚡ 直接代充 / 🎟️ 购买卡密）+ 购买卡密弹层（选数量→账单→**N 张卡密凭证**，逐张复制 + 一键复制 + 去兑换）+ 订单中心按 `fulfill_mode` 分支 + 钱包「冻结中」区块。验证：`tools/_v2170_dual_topup_verify.js` **22 PASS / 0 FAIL / 0 SKIP**（冻结→成功核销 / 冻结→失败解冻 / 卡密代充发 N 卡 + 可兑换 / 幂等 + UX U1~U5）；回归全绿（批量代充 40、向导 19、订单中心 20、版式 21、功能套件 50）；三门禁全绿。**未 git commit。**
- **前台布局对齐设计原型 + 租户级配色方案（v2.14.0）**：按用户指令完成 —— ①**前台布局迁移**（`public/site/index.html`）：结构对齐设计原型 `design/前台整体设计-v1.0.0.html`（单行大标题 Hero、发光 CTA 卡、三列信任条、三张能力卡、热门商品双价卡网格、权益包网格、下单三步、`<details>` FAQ 手风琴、多列页脚），原浅色硬编码全部改走 token；②**租户级配色方案**：`kc_tenant_brand` 加 `color_scheme`（容错 ALTER + 默认 `ink`），5 套方案（mint/ocean/violet/ember/ink）以 `:root[data-scheme=…]` token 块落前台，前台 `applyBrand()` 按租户配置下发 `<html data-scheme>`；**前台顾客不提供配色切换入口**；三个品牌接口（`/api/tenant/brand`、`/api/tenant-admin/brand`、`/api/admin/tenants/:id/brand`）读写 `color_scheme` 并白名单校验，两个后台 UI 加「配色方案」下拉；**平台默认 = `ink`「简约白」亮色**（平台租户 `primary_color`/`accent_color` 已清空、租户自定义 `primary_color` 仍优先）；③**修 bug**：`server.js` `bizTypeFromCategory()` 补 `'entitlement'` 映射（原权益商品订单 `biz_type` 落到 `other`）。验证：C11 商品类型同口径 E2E `tools/_v2140_cat_e2e.js` **15 PASS / 0 FAIL**；亮色默认生效（页面底 `rgb(247,248,250)`、主按钮 `rgb(59,108,246)`、标题单行、首页无深色残留、0 console error）；亮色登录态（代充列表/详情/钱包/充值弹层）正常；配色切换链路（切 `ocean` → 底色 `rgb(7,11,20)`、主按钮 `#4D9BFF`）；三门禁全绿。**未 git commit。**
- **充值页大改 + 后台报错排查（v2.2.0）**：按用户指令「充值页要大改、对客户不输小数位要明显提醒」——①**后端精确金额**（`server.js` 新增 `rechargeExactAmount`）：由 `recharge_no` 派生 4 位唯一小数尾数（如 `$200` → `200.0065 USDT`）作链上**认单标识**，**尾数不额外入账**（入账仍按整数分，余额精度不受影响、无需落库新列）；`POST /api/tenant/wallet/recharge` 响应加 `exact_amount`/`token`/`network`/`min`/`max`；②**充值弹层重写**（`public/site/index.html`）：`USDT · TRC20` 网络徽标 + 「选错链资金将无法找回」红字、「精确金额」红色区块 + 4 位小数强提醒（「少一位、多一分、或四舍五入成整数 → 转人工」）、手续费说明、**确认勾选闸门**（未勾选不能支付）、复制按钮 `clipboard`→`execCommand` 降级、金额限整数美元；③**后台报错普查**：`/admin` 23 tab + `/business-admin` 7 tab 全遍历，**231 次 `/api` 请求全 200**、无 4xx/5xx，唯一报错为离线 lucide CDN 级联（假报错）；④**图标库全局兜底**（`admin.html`/`index.html`/`subscription.html`）消除该假报错。验证：功能 **50/50**（含 F9 充值）+ 单元 **27/27** + UX 充值弹层 9 项（a~i）全 PASS + `/admin` 控制台 0 错误 + 三门禁全绿。**未动卡池 / 代理池等 KC 原生页面业务逻辑。**
- **Xboard 代码级摘除 + 上线前功能/UX 验收（v2.1.0）**：按用户指令「网站不再引用任何 Xboard，剔除相关代码，工程文件做标记」——①**数据迁入 KC 原生表**（`kc_plans` 扩 `prices_json`/`content`/`is_topup`/`topup_amount`/`show_flag`/`sell_flag`/`sort_order` 七列 + 新表 `kc_settings` + 卡片统一 `kc_listing_cards.card_json`）；②**后台全面改读 KC 原生表**（`/api/admin/products`、`products/save`、`card-config/*`、`entitlements/prices`、`user-lookup`→`kc_customers`、`site-config`），**新商品 code 改为「最大 `xplan_<n>` +1」与 id 解耦**；③**删除 Xboard 服务端残留**（`readXboardPatchStatus`/`xboard_patches`、`diag/legacy-fields`、`XBOARD_DB_NAME`、`sync-to-v2`），`server.js` **0 处 xboard/v2_plan**；④**业务模块去直连**（`user-auth.js` 改本地校验 KC 顾客签名令牌、`reconciliation.js` 不再读旧库、`legacy_system` 标签改 `storefront:*`）；⑤**前台/后台去文案**（删「补丁绿灯」卡片与「同步到 v2」按钮；`business-admin.html` 对账标签改「旧系统订单（已退场）」）；⑥**工程文件退役标记**（24 个 Xboard 时代工具 + deploy 回滚函数 + 冻结 `web/`）。验证：**功能回归 50/50 PASS**（登录/注册/创建商品/维护报价/买代充/买权益包/买 CDK/充值/查订单）+ **单元测试 27/27** + **UX 3 面全绿**（`/`·`/admin`·`/business-admin`，0 处 Xboard 文本；唯一控制台报错为离线 CDN 失载，属环境）+ **三门禁全绿**。⚠️ **Xboard 容器仍只停不删**（回滚资产保留，**切勿 `docker rm`**）。
- **Xboard 退场（Stage 3.9，v2.0.0）**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.9，执行 Stage 3 中**唯一移除回滚安全网**的破坏性步骤（用户拍板口径：**接管根路径 + 保留容器可回滚**）—— ①主站 `GET /` **接管为 KC 原生主站前台** `public/site/index.html`（`?cdk=X` 自动进兑卡视图、无参进首页；旧落地页 `public/index.html` 不再由 `/` 提供）；②**清除 Xboard 注入**（`custom_html` 405268 → 0 字符）；③**9 补丁/注入链退役只读**（`tools/xboard-patch-checks.js` 加 `RETIRED` 常量，核查脚本退役态直接上报 `{retired:true}` 并 `exit 0`；`deploy-manifest.json` xboard 加 `retired:true`；部署引擎 `.ps1`/`.sh` 的 start/deploy/verify/open-urls 排除 retired 服务、verify 单列 `[KEPT]`）；④**Xboard 容器只停不删**（`docker stop xboard`，保留为回滚资产）。验证：**全链路 200**（`/`·`/?cdk=`·`/redeem`·`/site`·`/tenant`·`/tenant-admin`·`/admin` + 核心 API）+ **UX 6/6**（`/` 为 KC 原生前台首页、导航恰 5 项、无「订阅」字样）+ **端到端对照 14/14 PASS**（Xboard 停机状态下注册→充值→下单→发卡→兑卡→查单）+ **回滚演练 PASS**（start xboard → apply 注入 405268 → 前台含 `realProgress` → 再清 405268→0 → stop）+ **三门禁全绿**。⚠️ **回滚路径务必保留**：置回 `inject=true` + `docker start xboard` + 跑 `tools/xboard-apply-custom-html.js`；**切勿 `docker rm` / `compose down -v`**。退出后进入观察期（无回退事故方可按原计划彻底摘除容器，另案需批准）。
- **退场第八步（Stage 3.8，v1.47.0）**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.8，在 `deploy-manifest.json` 将 **xboard 服务的 `inject` 由 `true` 改为 `false`** —— 部署/启动**不再重放** KC 前端注入（`custom_html` + 清缓存 + octane reload），正式进入 **Xboard 退场观察期**。因 G1~G5 阻断缺口已闭环、G6/G9/G11 亦闭环，主站体验已由 KC 原生前台 `GET /site` 覆盖。**本步是配置变更，不摘容器、运行时不即时生效**；回滚 = 置回 `true` 并跑 `tools/xboard-apply-custom-html.js`。验证：JSON 合法 + 三服务 `inject` 均为 `false` + 回滚脚本在位 + 三门禁全绿。**Xboard 未摘除**（3.9 才退场，且须待观察期满足「无回退事故」）。
- **退场第七步（Stage 3.7，v1.46.0）**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.7 落地 **保留面迁移（G11 闭环）** —— 依《Xboard原生功能处置清单》「工单/知识库保留、邀请保留入口但佣金不出圈」的定调，在主站前台**页脚新增「帮助与支持」行**：**工单支持 / 使用文档 / 邀请好友** 三个入口。运营可在租户品牌 `kc_tenant_brand.extra_json` 配 `ticket_url`/`kb_url`/`invite_url` 走**外链**，未配时回落**原生入口**（工单 → 「我的订单 → 订单详情 → 申请售后」；使用文档 → 滚到首页「常见问题」；邀请 → 弹层说明「邀请佣金在平台内结算、不对外开放提现」）。**同时复核导航 5 项口径（G9 闭环）**：顶部导航恒为 代充/成品号/建站服务/权益包/我的订单，无冗余「首页」。验证：功能 **14/14 PASS** + UX 全绿（页脚三链接、弹层文案、375px 不溢出）+ 三门禁全绿。**Xboard 未退场、未关注入**。
- **退场第六步（Stage 3.6，v1.45.0）**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.6 落地 **订单中心增强（G6 闭环）** —— ①数据层新建 `kc_after_sales`（顾客订单售后申请）；②`GET /api/tenant/orders` 加 `updated_at`；③新增 `POST /api/tenant/after-sales`（`authenticateCustomer`，作用域取 `req.tenant.id` + `req.customer.id`）；④主站前台「我的订单」加**状态筛选 tab**（全部/处理中/已完成/失败，带计数）+ **订单详情「订单进度」四节点时间线** + **「申请售后」弹层** + **「联系客服」入口**；充值单加 **30 分钟支付时限倒计时**（KC 原生下单即扣款、无「待支付」态，故倒计时落在充值单上）。验证：功能 **16/16 PASS** + UX 全绿（筛选/时间线/售后/倒计时）+ 三门禁全绿。**Xboard 未退场、未关注入**。
- **退场第五步（Stage 3.5，v1.44.0）**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.5 落地 **商品双价卡 + 首页门户（G5/G7 闭环）** —— ①**G7 权益价参与 KC 原生下单结算**：`GET /api/tenant/catalog` 每项加 `base_price`/`entitlement_price`/`entitlement_rule`/`entitlement_discount`，`POST /api/tenant/quote` 命中权益时锁权益价，`POST /api/tenant/orders` 按权益价扣顾客钱包 + 交付后 `entitlementConsume` 扣次（幂等）；前台 `priceHtml()` 渲染「权益价大字 + 原价划线 + 『权益价』标签 + 『用 1 次权益 · 省 $X』」；②**G5 首页门户**：主站前台 Hero 后新增 5 区块（为什么更省 / 三步完成 / 热门商品 / 权益包推介 / 常见问题），退场后首屏不再依赖 Xboard 注入的 `kc_home_portal`。验证：功能 **19/19 PASS** + UX 实测（5 区块齐全、列表详情双价、375px 不破版、0 JS 报错）+ 三门禁全绿。**Xboard 未退场、未关注入**。⚠️ 为验证双价，向 `kc_entitlement_prices` 插入了示例报价 `pack_light_off40 × xplan_1 = 900`（保留待运营确认）。
- **退场第四步（Stage 3.4，v1.43.0）**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.4 落地 **权益包前台（G4 闭环）** —— 权益包=平台自有资产，退场后购买入口不能消失，故在 KC 原生前台重建：①数据层 `kc_entitlement_rules` 加**售价** `sale_price_cents`（0=前台不可售）+ `kc_entitlement_grants` 加**顾客维度** `customer_id`（与历史 Xboard `user_id` 并存）+ 新建 `kc_customer_pack_purchases`（`client_ref` 幂等）；②前台 API `GET /api/tenant/packs` / `GET /api/tenant/entitlements` / `POST /api/tenant/packs/purchase`（**用顾客钱包余额开通**：扣款 → 发权益 → 记购买 + 写钱包流水，幂等 + 回滚）；③主站前台「权益包」视图（我的权益 + 可开通权益包卡 + 「用余额开通」，替换原过渡态占位）；④运营定价入口 `POST /api/admin/entitlements/packs/:code/price`。验证：功能 **18/18 PASS**（未登录可见 2 包 / 未登录 401 / 余额不足 402 / 充值后购买成功扣至 $40 / 我的权益 1 条 / 重复开通 409 / 幂等 / 流水 / 管理端定价 401）+ 数据核对（顾客维度 grant `user_id=0`、购买单、售价回填）+ UX 实测（点击「用余额开通」→ 已开通徽章 + 我的权益剩余 5/共 5 + 钱包扣 $60、375px 不破版、0 JS 报错）+ 三门禁全绿。**Xboard 未退场、未关注入**（阻断缺口 G5 仍在；权益价应用到原生下单的双价卡留 Stage 3.5 G7）。
- **退场第三步（Stage 3.3，v1.42.0）**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.3 落地 **钱包/充值前台（G2 闭环）** —— 新增**顾客级钱包**（`kc_customers.balance_cents` + 独立流水 `kc_customer_wallet_ledger` + 充值单 `kc_customer_recharges`）；主站前台新增「**我的钱包**」视图（余额大卡 + 档位 $100/$300/$500 + 自定义 + 流水明细 + 充值弹层）；充值走 **BEpusdt USDT（TRC20）收款**（**模拟**：生成收款地址 → 前台「我已支付」触发**收款回调**入账，幂等防重复）；**`tenant_web` 站内下单改从顾客钱包扣**（open API 仍从**租户余额**扣），两条账本严格分离（R2 红线「用户资金与对接方资金分开记账」）。验证：功能 **15/15 PASS**（401/初始 $0/档位/发起不入账/回调入账/幂等/越权 404/金额边界/顾客钱包扣款/402 不足）+ UX 实测（注册→钱包→充值 $300 到账、375px 不破版、弹层不重叠、0 机场词）+ `check-currency`/`check-docs-sync`/`check-root-hygiene` 全绿。**Xboard 未退场、未关注入**（阻断缺口 G4/G5 仍在）。⚠️ 充值为模拟：`confirm` 端点须在真实接入前改为「仅 BEpusdt notify 服务端验签入账」。
- **退场第二步（Stage 3.2，v1.41.0）**：落地 **兑卡/激活前台页（G1 闭环）** —— 主站前台新增「**兑换卡密 · 完成开通**」视图：卡密验证（`POST /api/verify-cdk`）→ 会话凭证本地校验（Session JSON / accessToken）→ 提交开通（`POST /api/run-process`）→ **WebSocket** 订阅 `jobKey` 实时进度；`GET /?cdk=X` 与新增 `GET /redeem` 均落到 KC 原生兑卡页（自动预填 + 自校验）。验证：路由/行为实测（`/?cdk=`、`/redeem`、`/` 回归）+ UX 实测（自动预填/自校验、375px 不破版、本页 0 JS 错误）+ `check-currency`/`check-docs-sync`/`check-root-hygiene` 全绿。**Xboard 未退场、未关注入**（阻断缺口 G2/G4/G5 仍在）。
- **退场第一步（Stage 3.1，v1.40.0）**：按《Stage3切换前对照清单-v1.0.0》§六 步序 3.1 落地 **主站顾客登录/注册（G3 闭环）** —— 新增 KC 原生**主站前台骨架**`public/site/index.html`（新路由 `GET /site`：品牌头 + **5 项导航**（代充/成品号/建站服务/权益包/我的订单）+ 首页/商品分类/详情/下单/我的订单）；顾客**注册/登录/会话**复用既有 `/api/tenant/auth/*`（主站即 `cli_platform` 平台租户，令牌 `sub='customer'`、7 天、**不落库**），跨租户令牌访问 → `403`；`GET /api/tenant/catalog` 补 `category` 字段支撑分类导航；平台租户品牌播种为「**KC 直供**」。验证：功能 **14/14 PASS**（F1 注册→登录→me / F2 跨租户 403 / F3 无 token 列）+ UX 实测（默认/375px/1500px 不破版、0 机场词）+ `check-currency` 通过。**Xboard 未退场、未关注入**（阻断缺口 G1/G2/G4/G5 仍在）。
- **多租户接手（Stage 2，v1.39.0）**：按《替换Xboard与白标多租户实施计划-v1.0.0》§十二 落地 —— ①KC 自建顾客账号（`kc_customers` + `/api/tenant/auth/*` 注册/登录/会话，令牌 `sub='customer'` 7 天不落库）；②租户白标前台最小版 `/tenant`（首页/商品/详情/下单/我的订单 + 品牌渲染，金额全 `$`、不启权益包）；③抽出**共享下单核心 `createApiOrderCore`**（open API 与租户前台同一套幂等 + 锁价 + 余额原子扣减 + 履约发卡）；④**代理商后台** `/tenant-admin` + `/api/tenant-admin/*`（`authenticateTenantStaff`，owner 才可改品牌/域名/员工，**不暴露平台成本/上游/其他租户**）；⑤前台直连 KC 的请求改走 Xboard 插件代理 `/kc-proxy/*`（前端源码无 KC 端口）；⑥`docs/方案/Xboard原生功能处置清单-v1.0.0.md`（工单/知识库保留、邀请保留入口但佣金不出圈、节点/流量/订阅/权限组隐藏）。**Xboard 未退场，主站切换留 Stage 3。** 验证：功能 F 全绿（幂等/跨租户 403/open API 回归）+ UX `/tenant/`、`/tenant-admin.html` PASS + 前台页无 `:3100`。遗留：「旧订阅折抵金额」是否隐藏待决策。
- **多租户地基（Stage 1，v1.38.0）**：按《替换Xboard与白标多租户实施计划-v1.0.0》§十一 落地地基 —— ①数据层：`kc_api_clients` 扩 6 列 + 4 张租户表（`kc_tenant_domains`/`kc_tenant_brand`/`kc_tenant_catalog`/`kc_tenant_staff`）+ 播种 `cli_platform` 平台租户；②请求侧 `resolveTenant` 中间件（`X-KC-Tenant` 头 → `Host` 查域名表 → 回落平台租户）与公开接口 `GET /api/tenant/brand?host=`；③技术后台新增「**租户**」页（租户 CRUD + 品牌 + 域名 + 商品目录 + 员工账号）；④`/api/integration/health` 加 `xboard_patches` 字段 + 首页「补丁绿灯」卡片（9/9）；⑤「商品管理」页补「上游健康」可视图。**不替换 Xboard、不改前台。** 验证：`tools/_v138_stage1_verify.js` **19/19 PASS**（US-1.1~1.6/F1~F6）+ UX U1~U4 实测全通过。**铁律**：租户作用域一律取自 `req.tenant.id`，禁止从请求体读 `client_id`；**上游路由为平台级能力、不对租户开放**。下一步 Stage 2（v1.39.0）分步接手。
- **工程目录归档整理 + 替换 Xboard 与白标多租户方案定稿（v1.37.0）**：按用户指令给工程目录瘦身归档（**只移动不删除**）——根目录顶层文件 138→59、`_*` 临时脚本 72→0，tools 顶层 330→87，共 347 项收进 `archive/`（五分类 + `_MOVE_LOG.md` 逐项登记「原路径 → 归档路径」）；新增 `tools/check-root-hygiene.js` 守护根目录整洁并挂 pre-commit；根目录散落文档归位（`docs/部署/`、`docs/接口/对接API.md`）；`deploy-manifest.json` 摘掉冻结的 `kc-gpt-pay2-web` 与 `3001:3000`、`docker-compose` web 服务加 `legacy-web` profile 停用。同时把「替换 Xboard + 白标多租户」定稿为 `docs/方案/替换Xboard与白标多租户实施计划-v1.0.0.md`（4 阶段路线 + 各阶段用例；**上游多源与多租户正交，上游路由不对租户开放**）。验证：4 个门禁脚本全绿 + `/api/public/runtime` 200 + US/F1-F4/U1-U3 全通过。**不动任何业务代码。** Stage 0 完成，下一步 Stage 1（v1.38.0）地基。
- **登录前首页（游客落地页）+ 登录页改版（v1.36.0）**：游客落地页按 sukai 风格全量重写信息架构 —— 公告条 → Hero（双 CTA：买账号 / 给已有账号充值）→ 需求决策区 → **按需选服务**（配置驱动，读 `/plan/kc-cards` 的分类，无商品则自动隐藏）→ 价格区块 → 两条路径 → **权益包推介** → 为什么选我们 → FAQ（6 条）→ 底部 CTA；**登录改为自建弹层**（`#kc-gl-modal`，登录 / 注册 双 Tab，无忘记密码 → 提示联系客服），直调 `POST /api/v1/passport/auth/login|register` 并自写 token 后 reload。游客三种意图续接（`sessionStorage.kc_gate` 的 `{planId}|{cat}|{goto}`）登录后自动落位。验证：`tools/_v136_guest_verify.js` **33/33** 全绿；回归 `tools/check-airport-lexicon.js` 17/19（2 项 FAIL 属订单详情页既有问题、非本版本引入）。⚠️ 已知问题：「旧订阅折抵金额」未被隐藏规则覆盖（权益包兑换类订单触发），待决策是否修复。
- **权益报价：每商品单独报价（v1.35.0）**：废弃「统一折扣」（规则级 6 折）口径 —— 权益价改为**每商品单独报价**，由运营在后台新页「**权益报价**」逐包逐商品维护（`kc_entitlement_prices` = 权益包 × 商品 一口价；**未配置 = 按原价**，不做兜底折扣）；**不同权益包对同一商品可报不同价**；首页门户与 `#/plan` 商品页**口径完全同源**（同调 `POST /user/kc/quotes`）。后台「权益」页规则表单与「站点与定价」面板保留不动（折扣字段降级为元数据）。验证：`tools/_v135_pricing_verify.js` **24/24** 全绿。⚠️ 报价表**初始为空**：运营未录价时前台全部按原价展示，属正常。
- **后台管理体验修复（v1.28.2）**：按 19 页后台 UX 走查结论统一修复——P0 权益弹窗裸渲染（`dialog-backdrop` CSS 缺失）补齐；权益表单去 cents/JSON 改 $ 与逗号分隔、枚举中文化；任务管理/自动化任务列布局修复；toast 移右上角；导航新增「任务与日志」分组；权益查询支持邮箱（新只读接口 `user-lookup`）。续费管理按用户决策保持不改。验证：`tools/_v1282_ux_verify.js` 全 PASS + 浏览器实测截图 + 接口实测。
- **修复：收银台美元订单被当人民币折算（v1.25.1）**：用户实测「购买卡密」$15 跳收银台显示「15 CNY · 2.24 USDT」——根因是 EPay 插件未传 fiat 参数，BEpusdt 易支付接口默认按 CNY 解读 money（÷6.69 汇率）。修复：插件 `$params` 增加 `'fiat' => 'USD'`（成品 `tools/xboard-patches/Epay/Plugin.php`，已打容器 + octane:reload），收银台恢复 1:1 美元口径；验收脚本 `tools/_v1251_fiat_usd_verify.js` 全绿（fiat=USD / money=15 / amount=15.02 / 测试单已清理）。
- **API 客户自助门户（v1.26.0）**：独立门户 `/api-portal`（与运营后台/商城三隔离）——下游客户用 API Key + Secret 登录，五页自助：概览（余额/调用统计/接入清单）、API 凭证（Key 明文、Secret 掩码+重置、签名三语言示例）、接入文档、我的订单（卡密可复制）、余额与消费（流水对账）；**运营总开关**在后台「API 客户」页顶部（关闭=门户维护中，不影响下游 API 调用）；充值/下单自动记 `kc_api_balance_ledger` 流水；信息红线：不暴露成本/加价率/上游身份；双轨验证 16+12 项全绿。
- **对外分销 API + API 客户（v1.25.0）**：双模式定价的 API 出口——对外 `/api/open/v1/*`（catalog/quote/orders/查单；API Key + HMAC 签名 + 时间戳 + 限流 + 预充值余额原子扣减；报价 60 秒锁价，成本变动 >3% 强制重报价；下单同步发卡）；KC 后台「API 客户」页（建客户发密钥/充值/停用/凭证）；上游目录「设成本」（加价的成本来源）；端到端双轨验证全绿（409 锁价/卡密/幂等/余额精确扣减/签名防线 + UI 走查）。
- **商品管理 MVP（v1.24.0）**：KC 后台「商品管理」页——一个页面配商品（列表 + 单表单编辑/新建：名称/周期/售价/货源下拉/卖点/说明/在售与显示开关/API 加价配置），「保存并同步商城」聚合写入 v2_plan + kc_plans + 资费规则 + 卡片 + 插件 packages 映射（订阅类自动写，新商品下单即可发卡）；菜单取代原「商品与资费」「商品卡片」入口；端到端验证全绿（改价双写 / 新建含发卡映射 / 无脏数据）。
- **修复：元/月残留 + 上游/资费入口（v1.23.1）**：新增套餐价格「元/月」类后缀清零（i18n unit 键 ×14 → `/月` `/季` 等；含邀请页「提现门槛(元)」）；隐藏两年付/三年付价格行；Xboard 后台「代充运营」链接修正为直达 KC 后台（`:3100/admin`，原误指 business-admin 冻结台）；`migrate-upstreams.js` 修复本机连接（自动加载 .env + 默认 3310）并完成回填（mock_zovo + 12 条目录，上游管理页从此有数据）；KC 后台菜单更名「上游管理」「商品与资费」。
- **管理端代充化（v1.23.0）**：Xboard 管理端 `/5fea4ca1` 三层运行时过滤器（`admin.blade.php` 壳层「KC-ADMIN-V2」）——i18n 覆盖（订阅管理→商品管理、订阅套餐→商品套餐、订阅计划→商品名称、周期→服务周期（月付→30 天/一次性→单次）、流量包→充值包、订阅→当前商品）；菜单收敛（优惠券/礼品卡/服务器/节点/权限组/路由/主题/插件/知识库隐藏，「节点管理」空组整组隐藏，保留「代充运营」入口）；字段过滤（权限组/在线设备/已用流量/总流量/到期时间列、套餐与用户弹窗机场字段、系统设置机场页签、仪表盘流量卡、行菜单机场项）；品牌 KC 加速 + ¥→$ + 站点名称/描述经 `Setting::set` 写入；断言工具 `tools/check-admin-airport.js` **33 PASS / 0 FAIL / 0 词典命中**。
- **全站机场字段屏蔽与代充化（v1.22.0）**：实测走查 9 项体验问题全处置——订单详情「类型/周期→服务周期（月付→30 天）」「产品流量→交付方式：卡密自动发放」；订单列表「周期→服务周期」列改名映射；个人中心「重置订阅信息」「通知」整卡隐藏；菜单三机场入口（使用文档/节点状态/流量明细）移除；`#/node`、`#/traffic` 路由拦截重定向首页；CNY→USD 货币守护扩展；门户卡按钮「立即订阅→立即办理」。引擎为文案精确匹配的运行时过滤器（只隐藏不删 Vue 节点、心跳+观察器自愈）；断言工具 `tools/check-airport-lexicon.js` **19/19 全 PASS**。同批连带部署 v1.14 主题增量（类型标已上线）。
- **后台解耦 R7·老字段下掉评估（v1.21.0）**：评估报告 `docs/方案/老字段下掉评估-v1.0.0.md`（首版）。**数据一致性 10/10 PASS**（v2_plan ↔ kc_plans+kc_pricing_rules+kc_listing_cards）但**本期不实际下掉**——需 BFF 代理接入 + 前台切读法两个收尾完成（v1.22.0+ 续作）。诊断能力：`GET /api/admin/diag/legacy-fields` 后台一键查双轨差异；`tools/check-legacy-readiness.js` 离线 CI/CD 接入（exit 0=ready / 1=有差异）。
- **后台解耦 R6·事件型权益（v1.20.0）**：插件 `KcIntegration` 主动上报事件（`POST /api/integration/entitlement/event`，按 event_code 精确匹配或 `'*'` 通配 source='event' 的规则），内置 handler `audit_log`（写流水 status=success）与 `plan_switch`（写流水 status=skipped + note 标注"v1.20.0 仅记录计划不实切换；实切换留 v1.21+"，避免越权）；handler 配置通过 rule.note 的 `handler=xxx` 读取，target 通过 `target=xxx` 读取；后台权益页"按 user_id 查询"扩展同时展示 grants + actions 两张表。KC 数据库新增 `kc_entitlement_actions` 表；端到端验证脚本 `tools/_v120_r6_e2e.js` 6 阶段全 PASS。
- **后台解耦 R5·权益高级（v1.19.0）**：插件 `KcIntegration` 发卡成功后自动回调 KC 触发权益 grant（`POST /api/integration/entitlement/issue-after-cdk`，按 plan_code × source='purchase' × trigger_plan_code 命中规则，幂等下发）；退款/失败回补端点 `POST /api/integration/entitlement/refund`（grant.remaining_uses + 1 + exhausted→active）；grant 流水回滚用 note='REFUNDED' 标记而非删除保留审计；端到端验证脚本 `tools/_v119_link_e2e.js` 9 阶段全 PASS。
- **后台解耦 R4·权益 MVP（v1.18.0）**：后台新增「权益」页（菜单顶级项 / lucide-ticket-percent 图标）——权益规则 CRUD（discount_type: percent/fixed_cents/fixed_price_cents × discount_value/门槛/配额/有效期/优先级/适用范围 plan_scope/触发源 source）、按 user_id 手动发 grants、查询/撤销 grants；`POST /api/pricing/quote` v1.18.0 起**启用 entitlement 分支**（取用户持有的最优 grant 与 manual/promotion 比价取低，落单 upsert `kc_order_pricing_snapshot` + 写 `kc_entitlement_uses` 扣次流水）；grant 并发防重（uk_user_rule_active + INSERT IGNORE）；扣次幂等（uk_grant_order）。KC 数据库新增 `kc_entitlement_rules` / `kc_entitlement_grants` / `kc_entitlement_uses` 三表；数据回填脚本 `tools/migrate-entitlements.js` 幂等可重跑（首次需手动执行，含 2 条 demo 规则）。
- **后台解耦 R3·展示层（v1.17.0）**：后台新增「商品卡片」页（菜单顶级项 / lucide-credit-card 图标）——基于 KC 视图 SKU 编辑卡片展示（title/subtitle/badge/type/listing_state/chips/features/guarantees/button/tip/footer_link/is_visible）；与 v2_plan.kc_card 解耦存 `kc_listing_cards`；提供「同步到 v2」一键双写兜底（让插件立即读到新配置）。KC 数据库新增 `kc_listing_cards` 表；数据回填脚本 `tools/migrate-listing-cards.js` 幂等可重跑（10 SKU → 10 张卡片）。**终极方案**（插件改读 KC 侧 BFF）留给 R7·读法切换。
- **后台解耦 R2·资费层（v1.16.0）**：后台新增「商品 SKU」页（菜单顶级项 / lucide-package 图标）—— KC 视图 SKU（code UNIQUE、kc_type=recharge/account/entitlement、upstream_code+plan_key 引用上游）+ 资费规则（source='manual'/'promotion'/'entitlement' × period × amount_cents 美分数 + priority + valid_from/until），支持整体替换与价格预览；`POST /api/pricing/quote` 价格引擎 MVP（按 plan_code 命中最高 priority + 手动 > 促销 > 权益，落单时 upsert `kc_order_pricing_snapshot` 保证退款可复算）。KC 数据库新增 `kc_plans`、`kc_pricing_rules`、`kc_order_pricing_snapshot` 三表；数据回填脚本 `tools/migrate-pricing.js` 幂等可重跑（10 SKU + 10 manual 规则）。本版本与 R1 同步**未改** 插件 `config.packages` 与前台商品页读法，R3 展示层时由 BFF 代理接入。
- **后台解耦 R1·上游接入层（v1.15.0）**：后台新增「上游接入」页（菜单顶级项 / lucide-server-cog 图标）——可视化新增/暂停/启用上游、查看/导入上游目录、刷健康（Mock）；KC 数据库新增 `kc_upstreams` / `kc_upstream_plans` / `kc_upstream_health_snapshots` 三表；数据回填脚本 `tools/migrate-upstreams.js` 幂等可重跑（首次需手动执行）。本版本仅 KC 侧独立管理 + 后台可视，**未改插件 `config.packages` 与前台**，切换读法留待 R3（按方案 `SP-2026-10-11-v1.0.1` §7 M3 双轨读）。
- **商品页游客浏览与卡片配置化（v1.14.0）**：商品页对未登录游客开放浏览（同一套商品与卡片配置，仅购买需登录）；商品卡新增**类型标**（文案/颜色可配）与**优惠行**（划线原价 + 促销文案，带**一键关闭的全局开关**，保存即生效）；底部服务链接能力保留、默认不显示；品牌水印不做。
- **客服工作台与美元显示守护（v1.13.0）**：客服只读工作台上线（余额 / 订单进度 / 充值到账 / 卡密查询 + 话术卡；运营壳内链直达）；全站金额一律以美元（$）显示落成硬约束（运行时兜底 + 检查脚本 + 提交钩子）；Xboard 补丁核查并入部署/重建流程（缺失自动重打）。
- **「购买卡密」前台入口（v1.12.0）**：商品卡新增次级入口，走经典「下单 → USDT 收银台 → 发卡」链路（后端全复用）；入口开关与文案在 Xboard 插件设置可配、**保存即生效、可随时关闭**；P2/P3 设计稿已产出（`docs/方案/卡密购买模式-前台设计-v1.0.0.md`）。
- **供应商健康摘要与履约链路（v1.11.3）**：补回 10-07 丢失的 S8 健康摘要（商城可售判定恢复——商品从「不可售」回到在售）；履约链路完成全链路模拟验证：真实下单 → 模拟到账回调 → 自动发卡 → 订单页展示卡密，幂等复验通过（零真实扣款）。
- **充值下限与收款链路（v1.11.2）**：充值最低金额下调至 $1（测试期）、修复充值页校验反向 Bug；TRC20 真实收款钱包完成绑定，「跳转收银台 / 到账回调」两环节验收通过；面板下单断点（容器补丁丢失致「已售罄」）已修复并全链路复测通过。
- **KC 对外集成接口恢复（v1.11.1）**：修复 10-07 回滚吞失的发卡实现——`/api/integration/*` 与后台「对外集成 / 商品卡片配置」面板恢复；三件验收全绿（13/13、15/15、并发 8 路 1 张）。
- **已完成**：跨平台一键部署（Windows/Linux 双击启停）+ `deploy-manifest.json` 服务清单单一可信源 + `verify` 漂移自检。
- **文档同步闸门**：`tools/check-docs-sync.js` 15 项自检 + pre-commit 硬拦截，跑测试前也会检查。
- **服务清单怎么加服务**：只改 `deploy-manifest.json` 一个文件，Windows 与 Linux 两套脚本自动跟随。
- **独立业务后台 R0–R4（Mock）**：商品配置、用户归属订单、USDT 随机尾数演练、异常核查、售后状态处理和交易凭证；不执行真实退款。
- **独立用户前台（Next.js）**：登录身份校验、商品浏览、创建自己的 Mock 订单、模拟支付/履约、售后留言、打印 Mock 凭证；真实充值/开通页面明确关闭。
- **R5 评估结果**：不重建新卡密库存；不探测真实供应商；沿用商品成本参考字段，不虚构毛利报表。
- **MIG-016 只读对账**：开发新旧系统订单/余额汇总核对；只按明确订单引用及唯一账号映射比较，支持不含个人信息的汇总 CSV；不回写、不自动同步。
- **Zovo 商品目录与订单映射**：商品按 GPT registry 键记录上游映射；本地售价仍由运营维护；Mock 订单保留本地请求号和上游映射，绝不创建真实 Zovo 订单。已部署，当前显示文档 fixture。
- **不可变红线**（任何迭代都不得放宽）：
  - ZovoCard 保持 Mock：`ZOVOCARD_MOCK=1` + `REQUIRE_ZOVOCARD_MOCK=1`
  - 用户提供的 ChatGPT Session/token/Cookie/密码/卡号永不落库；Xboard 登录令牌沿用既有浏览器登录机制，不进入业务库或审计
  - 真实支付、真实履约、对外上游 API **全部保持关闭**
  - KC 后台及技术菜单保持原样
  - 资金由不可变流水驱动；并发抢占必须用 `INSERT IGNORE`

### 4. 下一步

1. **运营人员验收 Zovo 商品映射**：独立后台目前显示文档样例目录；可确认套餐键、点数前置条件和本地售价维护方式。本次未使用运营账号写入商品或订单。
2. **验证 Mock 订单映射**：管理员建单与用户建单都会保留上游套餐映射和本地请求号，但显示未提交上游；本次未创建测试订单。
3. **访问范围提醒**：两个 `localhost` 地址仅适用于部署主机本机访问；其他设备访问需另配可访问域名。MIG-017 入口切换/迁移、真实支付、真实履约和生产钱包仍需单独批准。

### 5. 协作节奏

**先方案 → 再计划 → 分段执行，每段停下等确认。** 完成一段就汇报「做完了什么、下一步做什么」，不要连续推进多个阶段。

### 6. 快速命令

```powershell
# Windows
.\start_20261007.bat          # 启动全部服务
.\kc-deploy_20261007.ps1 verify   # 自检：实际运行 vs 清单期望
node tools\check-docs-sync.js     # 文档同步自检
```

```bash
# Linux / macOS
./start_20261007.sh
./kc-deploy_20261007.sh verify
node tools/check-docs-sync.js
```

<!-- ================== /开发协作入口 =================== -->

> **KC ChatGPT PLUS 訂閱開通平台**  
> 使用者貼上 Session 與兌換 CDK 後，可使用本地 Stripe 自動化流程，或啟用第三方代充 API 建立並輪詢代充訂單。  
> 配套管理後台：卡池管理、CDK 管理、任務監控、帳單稽核、第三方代充積分與套餐狀態、並發控制。

| 开发者 | TG | 
|--------|-----|
| **KC** | KcCatk |

[License: MIT](LICENSE) · Node.js 20+ · MySQL 8 · Playwright · Docker · [GitHub](https://github.com/KC-CatK/KC-PAY-GPT)

> ## 加入 Telegram 社群
> **[點此加入 AI科研組 Telegram 群組](https://t.me/+xPBORDjtky9mM2Mx)**

---

## 这是什么

`KC-GPT-PAY`（KC GPT 自动充值系统）是一套 **Node.js + Playwright + MySQL** 服务端方案，包含：

- **用户前台**（`/public/index.html`）：卡密兑换、Session 提交、订阅自动开通、状态查询
- **管理后台**（`/admin`）：卡池 / CDK / 任务 / 账单 / 系统配置 / 运行日志
- **本地自動化引擎**：Stripe Checkout 填表、信用卡輪換、hCaptcha 求解、反指紋瀏覽器與失敗重試
- **第三方代充 API**：支援套餐／積分查詢、Session 預檢、代充建單、訂單輪詢，以及失敗訂單的供應商卡密前綴顯示

啟用第三方代充 API 後，前台兌換會完全改走供應商代充流程，不再使用本地開通。

> ⚠️ **仅供学习与研究**。使用前请确保符合目标平台 ToS 与所在地法律法规。**开发者不对任何滥用导致的封号、扣款、法律纠纷负责。**

---

## 系统要求

| 组件 | 要求 |
|------|------|
| **Node.js** | ≥ 20.x |
| **MySQL** | ≥ 8.0 |
| **記憶體** | ≥ 2 GB（本地瀏覽器自動化建議 4 GB+） |
| **磁盘** | ≥ 5 GB（含 Chromium + Python hCaptcha 依赖） |
| **操作系统** | Linux / macOS / Windows |

Linux 无图形界面跑 headless 时，需安装 Playwright 系统依赖（见下方各平台说明）。

---

## 部署教程

### 方式一：Docker 一键部署（推荐）

适合 Linux 云服务器、macOS、Windows（Docker Desktop），**自带 MySQL 8**，无需单独装数据库。

#### 1. 安装 Docker

```bash
# Ubuntu / Debian（一键脚本）
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker && sudo systemctl start docker

# macOS / Windows — 安装 Docker Desktop
# https://www.docker.com/products/docker-desktop/
```

#### 2. 拉取代码并配置

```bash
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
DB_PASSWORD=your_strong_mysql_password   # MySQL root 密码
ADMIN_PASSWORD=your_admin_password         # 后台登录密码
PROXY=http://user:pass@proxy-host:port     # 本地自動化或第三方訂單代理（選填）
BROWSER_POOL=0                              # 預設關閉瀏覽器池
```

#### 3. 一键启动

```bash
docker compose up -d
```

首次构建镜像需数分钟（含 Playwright Chromium + hCaptcha Python 依赖）。启动成功后：

| 地址 | 说明 |
|------|------|
| `http://服务器IP:3000/` | 用户前台（卡密兑换） |
| `http://服务器IP:3000/admin-login` | 后台登录（默认路径可在后台修改） |

#### 4. Docker 常用命令

```bash
# 查看应用日志
docker compose logs -f app

# 重启应用
docker compose restart app

# 停止并移除容器（数据卷保留，MySQL 数据不丢）
docker compose down

# 更新代码后重新构建
docker compose up -d --build

# 进入容器调试
docker compose exec app bash
```

> **注意**：请勿使用 `docker compose down -v`，否则会删除 MySQL 数据卷。配置写入 MySQL 后，重启容器不会丢失。

---

## 第三方代充 API

在後台「系統配置 → 第三方代充 API」填寫 API Key 後啟用。預設 Base URL 為：

```text
https://kc.vpss.eu.cc/
```

啟用後，系統會：

1. 使用供應商 `/plans` 取得 GPT 與積分套餐資訊。
2. 以 `/balance` 顯示可用積分與 USD 餘額。
3. 以 `/pay/inspect` 檢查 Session 格式與 JWT 有效期，再以 `/pay` 建立代充訂單。
4. 輪詢供應商訂單結果；後台僅顯示失敗代充訂單及上游公開的 `topup_code` 前綴，不會保存或展示完整卡密。

API Key 至少需要 `plans:read`、`balance:read`、`pay:write` Scope；如需使用任務查詢，另需 `tasks:read`。完整供應商協議見 [對接 API 文件](docs/接口/对接API.md)。

> 瀏覽器池預設關閉（`BROWSER_POOL=0`）。第三方代充模式不使用本地瀏覽器開通流程。

---

### 方式二：多端裸机部署

适合不想用 Docker、或需要在本地调试的场景。

#### macOS / Linux 一键安装

```bash
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
chmod +x scripts/install.sh
./scripts/install.sh
```

脚本会自动检测系统（macOS / Ubuntu / Debian / CentOS 等），安装 Node.js 20+、npm 依赖、Playwright Chromium 及 Linux 系统库。

#### Windows 一键安装

以**管理员权限**打开 PowerShell：

```powershell
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

#### 手动安装（各平台通用）

**① 安装 Node.js 20+**

```bash
# macOS (Homebrew)
brew install node@20

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Windows — 下载 LTS 安装包
# https://nodejs.org/
```

**② 安装 Playwright 系统依赖（仅 Linux 服务器）**

```bash
# Ubuntu / Debian 推荐
npx playwright install --with-deps chromium

# 或手动安装常见依赖
sudo apt-get install -y wget curl fonts-liberation fonts-noto-cjk \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libxss1 libasound2 libpangocairo-1.0-0 libxshmfence1
```

macOS / Windows 无需额外系统依赖。

**③ 安装项目依赖**

```bash
npm install --production
npx playwright install chromium
```

**④ 安装并初始化 MySQL 8**

```bash
# Ubuntu
sudo apt-get install -y mysql-server && sudo systemctl start mysql

# macOS
brew install mysql && brew services start mysql

# 创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

**⑤ 配置环境变量**

```bash
cp .env.example .env
# 编辑 .env
```

裸机部署关键项：

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=plus_papay
ADMIN_PASSWORD=你的后台密码
PROXY=http://user:pass@proxy-host:port
HEADFUL=0          # 调试时可设为 1 开启有头浏览器
```

**⑥ 启动服务**

```bash
npm start
# 或调试模式（有头浏览器）
npm run start:headful
```

启动成功示例：

```
🔓 [资产锁] 启动时已重置所有 in_use 标记
数据库表检查完成
http://localhost:3000
MySQL => root@127.0.0.1:3306/plus_papay
```

---

### 方式三：PM2 生产守护（裸机推荐）

```bash
npm install -g pm2
pm2 start server.js --name kc-gpt-pay
pm2 startup          # 配置开机自启
pm2 save
pm2 logs kc-gpt-pay  # 查看日志
pm2 restart kc-gpt-pay
```

---

### 方式四：Nginx 反向代理 + HTTPS

通过域名访问或启用 HTTPS 时，在 Nginx 中反代到 `127.0.0.1:3000`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

免费 HTTPS（Let's Encrypt）：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 首次使用

1. 打开后台 → **系统配置**：填写代理、支付地区（默认菲律宾 PHP）、邮箱通道、hCaptcha 等
2. **卡池管理** → 批量导入信用卡（格式：`卡号|有效期|CVC|持卡人姓名`）
3. **免税地址** → 确认当前地区有足够地址模板（默认已预置）
4. **CDK 管理** → 生成 Plus / Pro 5x / Pro 20x 激活码
5. 用户访问前台 → 输入 CDK → 粘贴 Session JSON → 提交，约 3–5 分钟自动开通
6. 在 **任务管理** / **运行日志** 查看进度与结果

---

## 主要功能

| 模块 | 说明 |
|------|------|
| **CDK 兑换** | Plus / Pro 5x / Pro 20x 三档套餐，一卡一充 |
| **信用卡卡池** | 批量导入、智能选卡、冷却机制、Stripe 拒卡自动报废、失败换卡重试 |
| **支付地区** | PH / US / SG / MY 可切换，配套免税地址池 |
| **账单审计** | 自动记录每笔支付，支持筛选与 CSV 导出 |
| **瀏覽器池** | 本地自動化的可選多槽位模式；目前預設關閉（`BROWSER_POOL=0`） |
| **hCaptcha** | VLM / 打码平台 / Python solver 多通道 |
| **反指纹** | Stealth + 30+ 指纹点修正，支持真 Chrome / Edge |
| **Telegram 通知** | 任务成功 / 失败推送（后台配置） |
| **并发 & 维护模式** | 前台并发上限、维护开关，保存即生效 |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     server.js (Express)                      │
│   /api/redeem/*   /api/cdk/*   /api/admin/*   /api/public/* │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────┐            ┌─────────────────────┐
│  product_activator  │            │  public/admin.html  │
│  任务调度 / 重试     │            │  KC GPT 管理后台     │
└─────────────────────┘            └─────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  index.js / stripe-payment.js / session-auth.js / browser-pool │
│  Stripe Checkout 自动化 · Session 鉴权 · 卡池支付 · 重试      │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  MySQL — 卡池 / CDK / 任务 / 账单 / 配置 / Session 记录       │
└─────────────────────────────────────────────────────────────┘
```

---

## 目录结构

```
.
├── server.js              # Express 入口、REST API
├── product_activator.js   # 任务调度核心
├── index.js               # Stripe 支付主流程（子进程）
├── stripe-payment.js      # Checkout 表单自动化
├── session-auth.js        # Session 解析与鉴权
├── browser-pool.js        # 浏览器池管理
├── mysql-store.js         # MySQL 全部 CRUD
├── payment-retry.js       # 支付重试与换卡逻辑
├── region-config.js       # 支付地区配置
├── hcaptcha/              # Python hCaptcha solver
├── public/
│   ├── index.html         # 用户前台
│   ├── admin.html         # 管理后台
│   └── admin-login.html   # 后台登录
├── scripts/
│   ├── install.sh         # macOS / Linux 一键安装
│   └── install-windows.ps1
├── docker-compose.yml     # Docker 一键部署
├── Dockerfile
├── mysql-schema.sql
├── .env.example
└── docs/接口/对接API.md   # 第三方代充 API 對接文件
```

---

## 接口文档

本系統 REST API 請依 `server.js` 路由使用；第三方代充接口見 [對接 API 文件](docs/接口/对接API.md)。常用接口：

| 用途 | Method + Path | 鉴权 |
|------|---------------|------|
| 用户兑换开通 | `POST /api/redeem-product` | 无 |
| 查询 CDK 状态 | `GET /api/cdk/query?cdk=...` | 无 |
| 后台登录 | `POST /api/admin/login` | 密码 |
| 卡池批量导入 | `POST /api/admin/cards/import` | Bearer |
| 外部卡池推送 | `POST /api/external/cards/push` | X-API-Key |
| 账单 CSV 导出 | `GET /api/admin/billing/export` | Bearer |
| 实时运行日志 | `GET /api/admin/runtime-logs` | Bearer |

---

## 常见问题

**Q: Docker 里浏览器崩溃？**  
A: `docker-compose.yml` 已配置 `shm_size: 2gb`。仍崩溃可改为 `4gb`，并确保宿主机内存 ≥ 4 GB。

**Q: Linux 上 Chromium 启动失败？**  
A: 执行 `npx playwright install-deps chromium`，确认 `HEADFUL=0`（无头模式）。

**Q: MySQL 连接被拒绝？**  
A: Docker 模式下 `DB_HOST=mysql`（compose 服务名）；裸机模式下 `DB_HOST=127.0.0.1`。确认 MySQL 服务已启动。

**Q: Stripe 一直 `redirect_status=failed`？**  
A: 多为卡 BIN 被风控、余额不足或代理 IP 不干净。换卡、换代理、确认支付地区设置。

**Q: 卡池枯竭怎么办？**  
A: 后台批量导入，或配置 Webhook `POST /api/external/cards/push` 自动补货。

**Q: 修改哪些文件需要重启？**  
A: `server.js`、`mysql-store.js`、`product_activator.js` 等主进程文件需重启；`index.js`、`stripe-payment.js` 等子进程文件下次任务自动加载。

**Q: Windows 上 Playwright 安装失败？**  
A: 管理员 PowerShell 执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，再 `npx playwright install chromium`。

---

## 端口说明

| 端口 | 用途 |
|------|------|
| 3000 | Web 服务 + WebSocket（可通过 `PORT` 环境变量修改） |
| 3306 | MySQL（Docker 模式下映射到宿主机） |
| 19222+ | 瀏覽器池 CDP 連接埠（僅啟用 `BROWSER_POOL=1` 時使用） |

---

## 开发者 & 联系方式

| 项目 | 信息 |
|------|------|
| 开发者 | **KC** |
| TG | **KcCatk** |




---

## 免责声明

本项目所有代码以 **「AS IS」** 形式发布，开发者**不对以下情形负责**：

- 因使用本项目导致的 OpenAI 账号封禁、银行卡风控
- 违反目标平台 ToS 或所在地法律法规所引起的任何后果
- 因使用本项目导致的资金损失、数据泄露、第三方权益受损

**使用即表示你已阅读、理解并接受以上条款。**

---

## 许可

[MIT License](LICENSE) © KC
