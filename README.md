# KC GPT 自动充值系统

<!-- ==================== 开发协作入口 ==================== -->
<!-- 任何 AI 助手 / 新开发者 / 新会话：开工前请按顺序读完本区块，不要跳过 -->

## 🤖 开发协作入口（AI 与新成员必读）

> **如果你只读一段话，就读这段。** 本区块是项目的唯一权威入口，代码和文档的现状都以此处为准。

### 1. 当前版本

**`v1.34.0` · 2026-10-15 · 代充按「用户权益价」结算（接线：展示层 + 结算层 + 扣次）**

### 1b. 产品一句话

ChatGPT Plus / Pro 自动代充平台。当前独立业务前台和后台仅运行 Mock：用户浏览后台配置的商品、创建自己的模拟订单、推进模拟支付/履约、提交售后留言并查看凭证。
由 KC 引擎、独立业务前台、Xboard 旧流程回退商城、BEpusdt 旧收款网关和独立业务后台组成。**新前台不会收款、扣款、保存 ChatGPT Session 或调用 ZovoCard。**
功能清单、业务流程、未来规划详见 [`docs/产品全景.md`](docs/产品全景.md)。

> **当前交付边界**：独立业务后台入口为 `http://localhost:3100/business-admin`，独立 Mock 用户前台入口为 `http://localhost:3001`；Xboard 管理菜单进入业务后台。`/admin` 保持现有 KC 技术后台不变；后台沿用管理员邮箱/密码及原有二次验证设置。旧 Xboard 商城保留为回退路径；真实支付、余额扣减、ZovoCard 和履约调用均关闭。

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

API Key 至少需要 `plans:read`、`balance:read`、`pay:write` Scope；如需使用任務查詢，另需 `tasks:read`。完整供應商協議見 [對接 API 文件](对接api.md)。

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
└── 对接api.md             # 第三方代充 API 對接文件
```

---

## 接口文档

本系統 REST API 請依 `server.js` 路由使用；第三方代充接口見 [對接 API 文件](对接api.md)。常用接口：

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
