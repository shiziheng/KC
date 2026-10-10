# 长期工程记忆（MEMORY）· KC-PAY-GPT

> 长期约定/架构决策/稳定坑；状态看 `docs/00_项目状态.md`，当日写 `.workbuddy/memory/YYYY-MM-DD.md`。

## 协作与文档
- 节奏：先方案→计划→分段执行，**每段停下等确认**；开场读 `README.md`「开发协作入口」→`docs/产品全景.md`→`CHANGELOG.md` 顶部→本文件。
- 规范（`docs/开发规范.md`）六步：版本号→代码→同步产品全景→自测→CHANGELOG→入口；`CHANGELOG.md` 只追加、最新在顶部、含「验证/下一步」；`VERSION.json` 机器可读；`产品全景.md`=能力唯一正本，`00_项目状态.md` 只记环境/部署/待办。
- 闸门：`tools/check-docs-sync.js`（15 项）；pre-commit 拒提交（全景滞后/版本不一致/红线被删）；`npm run docs:check`。
- 基线（待确认）：`docs/方案/系统低耦合重整与上线路线-v1.0.0.md`（D1–D6）、`docs/方案/后台形态选型-自建vs改Xboard-v1.0.0.md`（=分层：运营台自建、Xboard 内核借壳）。

## ⚠️ Git 铁律（事故史）
- 有未提交内容**绝不** `git reset --hard`/`git stash`/`git clean -fd`（10-07 两事故）；破坏性测试用临时副本；留底 `tools/git-safe.js snapshot`（hash-object，不碰工作区）。
- 重建仓库报 `invalid object`→删 `.git/index` 再 add；git 中文路径输出是 GBK；提交前 `git status`、显式分组 add；身份仅仓库内 `KC-CatK <iamkc1110@gmail.com>`。
- 现状：全部已提交（归档 `44f6621`/`6119ff1`/`d6c0d00`；F1 修复 `f50eb2f`；文档 `eb156a7`）。

## 本机环境坑
- Bash 无 coreutils → 写 `.js` 用 node 跑、输出落文件再 Read；勿管道 coreutils。
- docker 全路径 `"C:/Program Files/Docker/Docker/resources/bin/docker.exe"`；npm 静默失败→`node "<managed>/node_modules/npm/bin/npm-cli.js" install`。
- PowerShell stdout 不回显；杀进程 `taskkill /F /PID`；headless Chrome 用一次性 profile，截图 `chrome.exe --headless=new --screenshot=`。
- `.bat` 必须 GBK+CRLF；中文 md 扫 `\uFFFD`；脚本先 `node --check`；服务监听 0.0.0.0；MySQL v8 客户端 `--ssl-mode=DISABLED`；容器内 `bash -c`。
- 凭据类输出会被本机敏感内容审批拦截（未授权即扣留：`SENSITIVE_APPROVAL=TIMED_OUT`）；涉凭据命令让用户在终端自跑，或用户在场时执行并配合授权；勿重试、勿绕行。

## 部署与运行（deploy-manifest.json=唯一服务清单）
- KC compose `kc-gpt-pay2`：app :3100→3000（探活 `/api/public/runtime`）、mysql :3310；重建 `docker compose up -d --build app`；`zovocard-client.js` bind 实时；启动器 `kc-*_20261007` 均读 manifest。
- Xboard：`xboard` :7001，后台 `/5fea4ca1`；改 custom_html 必 `php artisan optimize:clear`（走 `tools/xboard-apply-custom-html.js`）；容器补丁重建必重打（PlanService kc_is_topup 豁免；TopupController::prepare 去 show=1、默认 show=0）。
- BEpusdt：`bepusdt` :8080，后台入口 `/0c09205c71`（登录必须点按钮；10-10 已执行 reset，若入口变更以用户持有的新值为准），卷 `D:/tools/bepusdt`；易支付 `POST /submit.php`；`url=127.0.0.1:8080`（收银台）+`notify_domain=172.17.0.1:7001`（回调）；`reset` 不改 admin_secret；**TRC20 收款地址配置：后台「钱包管理」→「新增钱包」（名称/地址/交易类型）**；凭据不写进文档。

## KC 引擎
- ZovoCard 适配器与 `gpt-api-client.js` 同构：`X-API-Key: sk_`、信封 `code===0`、preflight、202 轮询、余额 `spendable_balance`；映射 `GPT_API_PLAN_MAP`；出网 SOCKS5 `ZOVOCARD_PROXY`（出口 216.223.16.210，换代理改白名单）。
- 表：`app_config`(kv)、`cdk_codes`、`task_logs`(job_key UNI)、`integration_cdk_issue`(ref UNI)。
- ⭐ 并发抢占必须 `INSERT IGNORE`（ODKU affectedRows 误报 1→超发）。

## 对外集成（Xboard→KC）
- `POST /api/integration/cdk/issue`（幂等）；GET 回查；`/api/integration/health`；头 `X-Integration-Key`；响应 `{success,data:{ref,cdk,plan_type,reused}}`；CDK 必须 `type='自助'`；发卡挂 `order.open.after`。
- ✅ v1.11.1 已修复（`f50eb2f`）：三件验收全绿（13/13、15/15、8 路并发 1 张）；health 404→200；恢复源 `.codex-recovery/2026-10-09-integration-recovered/`；并补回被吞实现（ZovoCard 挂载/卡池跳过/cfg.mock/卡密 180 天/告警）。密钥仍为联调测试值（正式收款前轮换）。

## Xboard 平台真相
- `ghcr.io/cedar2025/xboard`（PHP/Laravel/Octane，宿主无源码）：前台 hash 路由、仅 12 页、无钱包页；金额单位「分」；custom_html 注入在 `#app` 外；`v2_settings` 无 key 列；`v2_plan` 机场模型+补列 `kc_is_topup`/`kc_topup_amount`/`kc_card`。
- 红线（SP-2026-10-10）：只允许 ①保命补丁 ②插件 API ③壳层菜单；`admin/kc/*` 12 接口已部署（403=存活）。
- 坑：period 键错配；`plan/save` 不收 show/sell/renew/sort；余额=抵扣池（纯余额单需 `OrderService->paid('BALANCE-..')`）；分销快照 `order.open.after`（20/10/5）；`/invite/save` 是 GET。
- 插件 `plugins/KcIntegration/`：目录 PascalCase/code snake_case；`listen()`；路由无 `/api` 前缀，新增后 `octane:reload`；`order.open.after` 超时 5s→插件 HTTP 2~3s 全吞异常。

## 前端注入 & 业务闭环
- 注入三源 `tools/kc_{theme,panel,activate}_inject.html`；hashchange 路由；观察器只补插、固定 id；防中间态三件套（首帧压制/就绪解除/元素守卫）；教训：动态数据拆刷新函数、观察器回调加重入锁、验收看像素。
- 充值主路径 `payment.notify.verified`→加余额+COMPLETED→return；FEAT-011/012 向导：Session 零网络解析、只对 picked 行下单、`kcRenderStat()` 驱动统计。
- 独立轨道（`web/`、`business/`、`kc_business`）Mock **已冻结**；未来重启迁移：新表 `biz_` 前缀、不动旧表、隔离重新验收。
- 红线：`REQUIRE_ZOVOCARD_MOCK=1`/`ZOVOCARD_MOCK=1` 未批准不得解除；Session/Token/Cookie/密码/卡号不落库。

## 后台入口（凭据见 .env，勿猜、勿外写）
- KC `:3100/admin-login`；Xboard `:7001/5fea4ca1`（id=1 is_admin）；BEpusdt `:8080/0c09205c71`；KC `:3100/business-admin`（冻结）。
