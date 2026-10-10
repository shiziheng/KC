# 长期工程记忆（MEMORY）· KC-PAY-GPT

> 只放长期约定 / 架构决策 / 稳定坑。当前状态看 `docs/00_项目状态.md` 与 `docs/方案/`；当日记录写 `.workbuddy/memory/YYYY-MM-DD.md`。

## 协作约定与文档
- 节奏：先方案 → 计划 → 分段执行，**每段停下等确认**。开场读 `README.md`「开发协作入口」→`docs/产品全景.md`→`CHANGELOG.md` 顶部→本文件。
- 版本规范（`docs/开发规范.md`，强制）六步：定版本号→改代码→同步产品全景→自测→写 CHANGELOG→更新入口。`CHANGELOG.md` 只追加、最新在顶部，每条含「验证/下一步」；`VERSION.json` 机器可读。
- 权威归属：`docs/产品全景.md` = 产品能力/边界唯一正本（业务语言）；`00_项目状态.md` 只记环境/部署/待办；冲突以其为准。
- 文档闸门：`tools/check-docs-sync.js`（15 项自检）；pre-commit 钩子（全景滞后/版本不一致/红线被删 → 直接拒绝提交）。`npm run docs:check`。
- 现行架构基线（待用户确认 D1–D6）：`docs/方案/系统低耦合重整与上线路线-v1.0.0.md`（SP-2026-10-09）；后台形态选型（待确认，结论=运营台自建+内核借壳）：`docs/方案/后台形态选型-自建vs改Xboard-v1.0.0.md`（SP-2026-10-10）。

## ⚠️ Git 铁律（本机事故史，勿再犯）
- **有未提交内容时，绝不跑 `git reset --hard` / `git stash` / `git clean -fd`**（10-07 两起事故：reset 删掉未提交目录；stash pop 中断毁仓库）。破坏性操作测试只用临时副本；还原文件用 try/finally，不用 git。
- 快照留底用 `tools/git-safe.js snapshot`（hash-object 实现，不碰工作区）；别用 stash。
- 重建仓库后提交报 `invalid object` → 删 `.git/index` 重建。git 输出中文路径是 GBK → 比对先解码或走 hash-object。
- 提交前 `git status` 核实；显式分组 add 优先。身份仅仓库内配置：`KC-CatK <iamkc1110@gmail.com>`。
- 现状：文档已提交至 `0855561`；**v1.9–v1.11 代码改动（约 40 文件）仍未提交** → 阶段 0 优先固化；期间禁止破坏性 git 操作。

## 本机环境坑
- Bash 无 coreutils → 写 `.js` 用 node 跑、输出落文件再 Read；命令勿管道给 coreutils。
- docker 全路径 `"C:/Program Files/Docker/Docker/resources/bin/docker.exe"`；PowerShell stdout 不回显，杀进程用 node `taskkill /F /PID`。
- npm 静默失败 → `node "<managed>/node_modules/npm/bin/npm-cli.js" install`。
- `.bat` 必须 GBK(936)+CRLF；中文 md 写完扫 `\uFFFD`；大脚本改前 `node --check`。
- headless Chrome：一次性 profile+新端口+try/finally kill；截图 `chrome.exe --headless=new --screenshot=`。
- Node 服务监听用 0.0.0.0（localhost 仅绑 ::1）。
- 连 MySQL（v8 客户端）：`--ssl-mode=DISABLED`（`--skip-ssl` 已不适用）；容器内 `sh` 不支持 `<`，用 `bash -c`。

## 部署与运行（deploy-manifest.json 为唯一服务清单）
- KC compose `kc-gpt-pay2`：app :3100→3000（探活 `/api/public/runtime`），mysql :3310；重建 app 用 `docker compose up -d --build app`，`zovocard-client.js` bind 实时。
- 引擎/启动器 `kc-deploy_20261007.ps1/.sh` + `start_/stop_/deploy_/console_20261007.{bat,sh}`，均读 manifest；`verify` 对比实际容器与期望集合告警漂移。
- Xboard：容器 `xboard` :7001，后台 `/5fea4ca1`；改 custom_html 必须 `php artisan optimize:clear`，一律走 `tools/xboard-apply-custom-html.js`。
- Xboard 容器补丁（重建必重打）：`PlanService.validatePlanAvailability` 加 kc_is_topup 豁免；`TopupController::prepare` 去 `show=1`、默认 show=0。
- BEpusdt：容器 `bepusdt` :8080，后台 `/0c09205c71`，卷 `D:/tools/bepusdt`。
- `.env`（根）放凭据/开关，不写进文档。

## KC 引擎
- ZovoCard 适配器与 `gpt-api-client.js` 同构：`X-API-Key: sk_`、信封 `code===0`、建单前 preflight、202 须轮询、余额看 `spendable_balance`；套餐映射 `GPT_API_PLAN_MAP`；出网 SOCKS5 `ZOVOCARD_PROXY`（出口 216.223.16.210，换代理同步改白名单）。
- 表：`app_config`(kv)、`cdk_codes`、`task_logs`(job_key UNI)、`integration_cdk_issue`(ref UNI)。
- ⭐ 并发抢占必须 `INSERT IGNORE`（ODKU 冲突 affectedRows 仍返 1 → 超发）；勿用 mysql CLI `ROW_COUNT()` 验证。

## 对外集成（Xboard→KC）
- `POST /api/integration/cdk/issue` 幂等（ref=订单号），GET 回查 + health 免鉴权；头 `X-Integration-Key`；响应 `{success,data:{ref,cdk,plan_type,reused}}`；CDK 必须 `type='自助'`；发卡挂 `order.open.after`。
- ⛔ 2026-10-09：此组接口在 10-07 恢复时被回滚丢失（实测 404）；材料已固化 `.codex-recovery/2026-10-09-integration-recovered/`。修复 = 逐段合并回当前版本 + `tools/test-integration-issue-{logic,e2e,race}.js` 三件验收；**验收前不得开启真实收款**。

## Xboard 平台真相
- `ghcr.io/cedar2025/xboard`：机场出身的 SaaS 面板（PHP/Laravel/Octane，宿主无源码）；前台 hash 路由无 SPA fallback、仅 12 页、无钱包页；金额单位「分」；custom_html 注入位在 `#app` 外；`v2_settings` 无 key 列。
- 商品表 `v2_plan` 为机场模型（权限组 group_id / 流量 transfer_enable / 限速 / 设备数 / 流量重置——代充无关）；我们补了三列：`kc_is_topup` / `kc_topup_amount` / `kc_card`（商品卡配置 JSON）。
- 管理端=编译 SPA；壳层注入已收敛菜单 6 项 + 「代充运营」外链。改动红线（SP-2026-10-10，待确认）：Xboard 只允许 ①保命补丁 ②插件 API ③壳层菜单 三类改动，其余进自建运营台；插件 `admin/kc/*` 12 个接口已部署（403=存活）。
- 坑：period 键错配需事务内转换；`plan/save` 不收 show/sell/renew/sort；余额=抵扣池，纯余额单需 `OrderService->paid('BALANCE-..')` 推进；分销 commission 在 `order.open.after` 快照（l1/2/3=20/10/5）；`/invite/save` 是 GET。
- 插件 `plugins/KcIntegration/`：目录 PascalCase、code snake_case；钩子用 `listen()`；路由无 `/api` 前缀，新增路由后 `octane:reload`；`order.open.after` 在 OrderHandleJob（超时 5s）→ 插件内 HTTP 超时 2~3s 且全吞异常，只能记录不能回滚。

## 前端注入 & 业务闭环
- 注入三源 `tools/kc_{theme,panel,activate}_inject.html`（只取 `<script>`）；hashchange 路由；观察器只补插；固定 id 幂等。防中间态三件套：首帧压制 / 就绪式解除（硬超时兜底）/ 元素级守卫。教训：innerHTML 拼动态数据要拆刷新函数；观察器回调加重入锁；验收走真实路径看像素。
- 充值主路径 `payment.notify.verified` → 加余额 + COMPLETED → return（短路原生履约）。FEAT-011/012 向导：Session 批量解析零网络；只对 picked 行下单；统计行由 `kcRenderStat()` 驱动。
- 独立轨道（`web/` Next.js、`business/`、`kc_business`）为 Mock，**已按方案冻结**：不删不迁不接流量、不再开发（去留看阶段 4）；若未来重启迁移（MIG-017）：新表 `biz_` 前缀、不动 KC/Xboard 旧表、隔离重新验收。
- 红线：`REQUIRE_ZOVOCARD_MOCK=1` / `ZOVOCARD_MOCK=1` 未经批准不得解除；Session/Token/Cookie/密码/卡号不落库，只允许经批准的脱敏摘要。

## 后台入口（凭据见 .env）
- KC `:3100/admin-login`；Xboard `:7001/5fea4ca1`（id=1 is_admin）；BEpusdt `:8080/0c09205c71`（登录必须点按钮）；`:3100/business-admin`（已冻结）。
- BEpusdt：易支付兼容 `POST /submit.php`；地址分层 `url=127.0.0.1:8080`（收银台）+ `notify_domain=172.17.0.1:7001`（回调）；后台缺 Referer 返 403；`sets` payload 须数组；`reset` 只改用户名/密码/入口，不动 `admin_secret`。
