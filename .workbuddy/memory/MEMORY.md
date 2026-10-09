# 长期工程记忆（MEMORY）· KC-PAY-GPT

> 长期有效内容（约定 / 架构决策 / 稳定坑）。过程与当前状态看 `docs/00_项目状态.md`；当日记录写 `.workbuddy/memory/YYYY-MM-DD.md`。

## 协作约定
- 节奏：先方案 → 计划 → 分段执行，**每段停下等确认**。
- 设计/计划/状态文档统一放 `docs/`；开场先读 `README.md` 顶部「开发协作入口」→`docs/产品全景.md`→`CHANGELOG.md` 顶部第一条→本文件。
- **版本迭代规范（2026-10-07 起强制）**：见 `docs/开发规范.md`。流程六步：定版本号→改代码→**同步产品全景（涉及功能时必做）**→自测验证→写 CHANGELOG→更新入口。规则：`CHANGELOG.md` 是版本记录唯一正本（**只追加、只升版本、不覆写历史**，最新永远在顶部第一条）；`VERSION.json` 机器可读当前版本；`README.md` 顶部「开发协作入口」是任何模型的开场读入点。每条版本记录**必须含「验证」和「下一步」**。
- **文档权威归属（防冲突/防腐化）**：`docs/产品全景.md` 是**产品能力与边界唯一正本**（功能/业务流程/未来规划三档/明确不做什么），用**业务语言**写（谁在用→做什么→看到什么；接口名/字段名只放 `docs/接口/`）；与散落的 FEAT/ARC/S0～S13 文档冲突时**以产品全景为准**。`00_项目状态.md` 只记环境/部署/待办/文件索引，**不维护产品功能**。

## ⚠️ 文档同步闸门（不靠自觉）
- `tools/check-docs-sync.js` —— 15 项自检（版本一致/全景滞后/章节完整/三档未混/红线未删/规范步骤/编码/入口引用）。
- 已启用 **pre-commit 钩子**（`git config core.hooksPath .githooks`）：全景滞后、版本号不一致、红线被删 → **提交被直接拒绝**。绕过仅限 `--no-verify`。
- `npm run docs:check`；`pretest` 已接入，跑测试前先过闸门。
- **滞后检测原理**：产品全景顶部「对应版本」必须 ≥ 当前版本 —— 改了功能忘更新全景就会被抓到。

## ⚠️ 本机 Git 操作教训（务必遵守）
- **绝对不要在有未提交新文件的工作区跑 `git reset --hard` / `git stash` / `git clean -fd`**（尤其别为"验证钩子"而在真实工作区做测试）。2026-10-07 连发两起事故：①`reset --hard` 删掉未提交的 `domain/`、`fulfillment/`、`public/business.html`；②`git stash` pop 中断致 `.git/refs` 与 pack 损坏、git 全线失效。**真实永久丢失仅 3 项**：`domain/`、`fulfillment/`、`public/business.html`。（此前"business/domain/fulfillment/business-infra 四目录全丢"是损坏仓库状态下的误报——`business/`、`business-infra/`、`public/business-admin.html`、`接口api.md`、`docs/归档/` 实际都在。）
- **测试破坏性 git 操作用临时副本目录**，绝不在真实工作区跑。要做故障注入验证，改完文件用 try/finally 还原（不要 git 还原）。
- **快照留底用 `git hash-object -w` 而非 `git stash`**：本机 stash 引用易损坏（实测 pop 中断后 refs 丢、仓库废）；`tools/git-safe.js snapshot` 已是 hash-object 实现，完全不碰工作区。
- **`git init` 重建损坏仓库后，旧 index 会引用已丢失的 blob（提交报 `invalid object ... for <file>`）**：先 `fs.unlinkSync('.git/index')` 再 `git add -A` 重建 index，提交才成功。
- **本机 git 输出中文路径是 GBK（非 UTF-8）**：node 里用 `fs.existsSync` 或字符串比对 git 输出的中文路径会误判。校验内容用 `git hash-object` 对 ASCII 路径比对最可靠；中文文件名走 `git ls-tree -r HEAD` 时也要先解码。
- 提交前 `git status` 核实；**显式分组 add 优先，`git add -A` 仅配合已验证的 .gitignore 使用**（否则调试残留会混入）。
- **提交重要工作前先提交或建分支**——未提交的新目录一次 reset 就无法挽回。
- git 提交者身份**只配在仓库内**（`git config user.name/email` 不加 --global），本仓库沿用 `KC-CatK <iamkc1110@gmail.com>`。
- 恢复误删的已跟踪文件：`git checkout -- <path>`（安全）；**从未跟踪的文件无法恢复**，只能靠 `git-safe.js snapshot` 提前留底。
- **仓库已恢复并提交**：`e65825a` (v1.7.1, 193 文件)。安全护栏 `tools/git-safe.js` + `.githooks/pre-commit`(文档闸门) + `.githooks/pre-push`(无备份资产扫描) 已就位。
- **2026-10-09：v1.9–v1.11 全部改动（约 40 文件）仍未提交**（最后提交停在 `58d755a`）——阶段 0 必须优先固化提交；勿在未提交状态下做任何破坏性 git 操作。

## 本机环境约束（跨项目，最易浪费时间）
- Bash 无 coreutils（ls/cat/head/tail/sleep/sh/rm...）→ 写 `.js` 用 node 跑；输出落文件再 Read。
- 不要把命令管道给 coreutils（`cmd | tail` 会 SIGPIPE 掉左端）。
- `docker` 不在 PATH → 全路径 `"C:/Program Files/Docker/Docker/resources/bin/docker.exe"`。
- PowerShell stdout 不回显；`Stop-Process` 被拦 → node `taskkill /F /PID`。
- npm 静默失败 → `node "<managed>/node_modules/npm/bin/npm-cli.js" install`。
- headless Chrome 残留锁 profile → 一次性 profile+新端口+try/finally ch.kill()。
- Node localhost 只监听 ::1 → 用 0.0.0.0。
- **.bat 必须 GBK(936)+CRLF**，否则 cmd 解析错位（报 `'hell'`）、中文乱码。
- 写完中文 md 用 node 扫 `\uFFFD`；改大段注入脚本前必须 `node --check`。
- **git 钩子里 `node` 可解析**（Git 自带 sh 的 PATH 含 managed node），钩子不会因找不到解释器失效。
- 本机 Chrome 截图：`"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --screenshot=`。

## 部署与运行（deploy-manifest.json 为单一可信源）
- 引擎：`kc-deploy_20261007.ps1`（Win）/ `.sh`（Linux）；启动器 `start_/stop_/deploy_/console_20261007.{bat,sh}`。
- **服务清单集中在 `deploy-manifest.json`**：脚本 start/stop/deploy/status/verify 都读它；新增服务只改 manifest 一处。`verify` 对比实际运行容器 vs 期望集合并告警漂移。
- KC：compose `kc-gpt-pay2`；app 宿主3100→3000，mysql 宿主3310；探活 `/api/public/runtime`。
- 重建 app：`docker compose up -d --build app`。`server.js`/`mysql-store.js`/`public/` 需重建；`zovocard-client.js` bind 实时。
- Xboard：容器 `xboard`，宿主7001，后台 `/5fea4ca1`，库 `xboard`（复用 KC MySQL 经 172.17.0.1:3310）。
- BEpusdt：容器 `bepusdt`，宿主8080，后台 `/0c09205c71`，卷 `D:/tools/bepusdt`。
- `.env`（根）放凭据/开关，**不写进文档**。
- Xboard 改 custom_html 必须 `php artisan optimize:clear`（否则跑旧脚本）；一律走 `tools/xboard-apply-custom-html.js`。
- 容器内 MySQL=MariaDB 强制 TLS → 连宿主加 `--skip-ssl`。
- Xboard 容器补丁（重建必重打）：`PlanService.validatePlanAvailability` 加 kc_is_topup 豁免；`TopupController::prepare` 去 `AND p.show=1`、默认 show=0。

## KC 侧架构
- ZovoCard adapter 同名接口替换 `gpt-api-client.js`；协议 `X-API-Key: sk_`、信封 `code===0`；建单前 `preflight`；202≠成功须轮询；余额看 `spendable_balance`。
- 套餐映射 `GPT_API_PLAN_MAP`；出网经 `ZOVOCARD_PROXY`（SOCKS5，出口 `216.223.16.210`，换代理同步改白名单）；axios `proxy:false`+`socks-proxy-agent`。
- `app_config` key-value 表；表 `cdk_codes`/`task_logs`(`job_key` UNI)/`integration_cdk_issue`(`ref` UNI)。
- mysql 容器内 `sh` 不支持 `<` → 必须 `bash -c`，否则造数静默失败。

## 对外集成（KC→Xboard）
- `POST /api/integration/cdk/issue`（幂等）/回查/免鉴权 health。鉴权 `X-Integration-Key`。
- 响应契约 `{success:true,data:{ref,cdk,plan_type,reused}}`（非 Zovo `code===0`）。CDK 必须 `type='自助'`（否则 403）。
- 发卡挂 `order.open.after`（非 payment.notify.success）。
- ⛔ **2026-10-09 核查：本组接口在 10-07 恢复时被整体回滚丢失**（`server.js` / `mysql-store.js` / `public/admin.html` 被回退到 09-24 版本），运行实测 404；完整实现已自 WorkBuddy 文件历史找回并固化在 `.codex-recovery/2026-10-09-integration-recovered/`（10-05 快照）。**修复 = 逐段合并回当前版本 + 跑 `tools/test-integration-issue-*.js` 三件验收；修复验收前不得开启真实收款。**

## ⭐⭐ 并发抢占必须 INSERT IGNORE（跨项目实测）
- ODKU 冲突 affectedRows 仍返 1 → 超发；`INSERT IGNORE` 才正确。占位→抢到生成回填→失败释放占位+作废孤儿。
- 勿用 mysql CLI `ROW_COUNT()` 验（与 mysql2 语义不同）。

## Xboard 平台真相（已核实源码）
- 版本 `ghcr.io/cedar2025/xboard`（PHP8.2/Laravel11/Octane；宿主无源码）。
- 前台 hash 路由无 SPA fallback：`/#/order/{trade_no}` ✅，`/order/xxx` 直连 404。仅 12 页，无钱包/礼品卡页。
- custom_html 注入位在 `#app` 外；`ThemeService::updateConfig()`（实例）；`v2_settings` 无 `key` 列。
- 用户信息 `GET /api/v1/user/info`；金额单位「分」。
- 余额=内部抵扣池，无充值类型；`handleUserBalance` 只改金额不改状态。
- period 键错配：`plan/save` 用 `monthly/.../onetime`，用户端校验旧键 `month_price/...`；事务内转换。
- `plan/save` 不接受 show/sell/renew/sort → 走 `plan/update`+`plan/sort`。
- 礼品卡方案A：`rewards={"balance":10000}`→`redeem`→余额→下单抵扣（前台无兑换页，只能客服代充）。
- 分销：`order.open.after` 快照 commission；三级 l1=20/l2=10/l3=5；`/invite/save` 是 GET（POST 405）。

## Xboard 插件开发（`plugins/KcIntegration/`）
- 目录 PascalCase，code snake_case；`Plugin.php`+`config.json`（code 匹配 `/^[a-z0-9_]+$/`，version `x.y.z`）。
- 钩子用 `listen()` 非 `register()`；路由无 `/api` 前缀、不带鉴权需 `middleware('user')`；新增路由后 `octane:reload`。
- `order.open.after` 在 `OrderHandleJob`（$timeout=5）→ 插件内 HTTP 超时 2~3s 且全吞异常，只能记录不能回滚。
- `OrderService::open()` 只认 STATUS_PROCESSING(1)，需 `new OrderService($order)`。

## 前端注入三份源 + 防中间态三件套
- 源：`tools/kc_theme_inject.html`+`kc_panel_inject.html`+`kc_activate_inject.html`。注入只取 `<script>` 内容。
- 路由用 `hashchange`；MutationObserver 只补插不判路由。卡片固定 id 幂等；失败静默。
- **防中间态三件套**：①首帧压制（CSS 打标记隐藏原生）②就绪式解除（等真实产物信号，硬超时兜底，兜底移除只写超时分支）③元素级守卫（`:not(.改造类)` 隐藏）。
- **通用教训**：`innerHTML` 拼接片段数据会变 → 拆独立刷新函数；观察器回调内改 DOM 要重入锁；验收走真实用户路径+看像素（DOM 断言抓不到白屏）。

## 充值/代充闭环
- 充值主路径 `payment.notify.verified`→加余额+COMPLETED→`handle()` return（原生履约短路）。
- Xboard 余额是抵扣券非支付方式：纯余额单停 status=0，需 `OrderService->paid('BALANCE-..')` 推进。
- FEAT-011/012 向导：Session 批量解析零网络；支付链只对 picked 行下单；统计行 `kcRenderStat()` 四处驱动。

## 独立业务库与安全护栏（SEC-003/DATA-003）
- **设计约束仍有效，实现状态已作废**：独立业务代码、迁移工具和适配器已随 2026-10-07 误操作丢失，不能假设 `business-infra/`、`migrate.js` 或 `kc_business` 迁移存在/已应用。未来重做时业务表使用 `biz_` 前缀、不改 KC/Xboard 旧表；数据库名隔离须重新落地并验收。
- 重做时持续保持 `REQUIRE_ZOVOCARD_MOCK=1`、`ZOVOCARD_MOCK=1`；任何真实履约另设安全门并须明确批准。Session/Token/Cookie/密码/卡号不保存，只允许经批准的脱敏账户摘要。

## 独立后台任务状态纠正（2026-10-07）
- 产品方案仍是已确认基线，但独立后台/前台的实现目录和页面当前缺失；此前 ARC-001～MIG-016 的“已完成/已落地”表述均为过期且不准确的状态，不得据此跳过开发或验收。
- 当前 Git 中保留的 `tools/verify-business-backend.js` 是依赖缺失接口的旧验证脚本，不代表业务实现存在。
- `docs/计划/代充独立后台开发计划-v1.0.0.md` 原文件缺失；现在重建的是恢复版任务清单，所有开发项重置为待审核/待实施。数据库旧迁移状态未经本次检查验证。

## 后台入口（凭据见 `.env`，勿猜）
- KC `:3100/admin-login`；Xboard `:7001/5fea4ca1`（id=1 is_admin）；BEpusdt `:8080/0c09205c71`；KC `:3100/business-admin`（独立业务后台，Mock，随独立轨道冻结）。
- `bepusdt reset` 改用户名/密码/入口三样，但 `admin_secret`（对接令牌）不变；取凭据 `strings .../sqlite.db-wal | grep admin_`。
- BEpusdt 登录必须点按钮（Enter 无效）。

## BEpusdt（USDT 收单）
- 镜像 `v03413/bepusdt:latest`（Go+SQLite，非托管）；易支付兼容 `POST /submit.php` PID=1000 KEY=对接令牌 签名升序拼接。
- 地址分层：`v2_payment.config.url=127.0.0.1:8080`（收银台）+`notify_domain=172.17.0.1:7001`（回调）。
- 后台登录缺 `Referer` 返 403；`sets` payload 须数组。
