# 长期工程记忆（MEMORY）· KC-PAY-GPT

> 状态看 `docs/00_项目状态.md`；当日写 `.workbuddy/memory/YYYY-MM-DD.md`。

## 协作与文档
- 节奏：方案→计划→分段执行，**每段停下等确认**；开场读 `README.md` 顶部→`产品全景.md`→`CHANGELOG.md` 顶→本文件。
- 规范六步（`docs/开发规范.md`）：版本号→代码→同步全景→自测→CHANGELOG→入口；`CHANGELOG.md` 只追加、含「验证/下一步」；`产品全景.md`=能力唯一正本；闸门 `tools/check-docs-sync.js`+pre-commit。
- 方案基线（待确认）：低耦合重整 v1.0.0、后台选型 v1.0.0。

## ⚠️ Git 铁律（事故史）
- 未提交内容**绝不** `reset --hard`/`stash`/`clean -fd`；破坏测试用临时副本；留底 `tools/git-safe.js snapshot`。
- 重建仓库 `invalid object`→删 `.git/index` 再 add；git 中文路径输出 GBK；提交前 `git status`、分组 add；身份 `KC-CatK <iamkc1110@gmail.com>`。

## 本机环境坑
- Bash 无 coreutils→用 `.js`+node 跑、输出落文件再 Read；docker 全路径 `"C:/Program Files/Docker/Docker/resources/bin/docker.exe"`；npm 静默失败→`node <managed>/node_modules/npm/bin/npm-cli.js install`。
- PowerShell stdout 不回显、杀进程 `taskkill /F /PID`；headless 一次性 profile；`.bat` 必须 GBK+CRLF；中文 md 扫 `\uFFFD`；监听 0.0.0.0；mysql 客户端 `--ssl-mode=DISABLED`；容器内 `bash -c`。
- 涉凭据输出会被敏感审批拦截→让用户自跑/在场授权；**密钥脚本内用、绝不打印**（`node:sqlite` readOnly 直读 `D:/tools/bepusdt/sqlite.db`）。
- 同文件多处 Edit **别同批提交**（实测会丢改动）；重要编辑逐条落盘后用 node `includes` 复核标记。

## 部署与运行（deploy-manifest.json=服务清单）
- KC `kc-gpt-pay2`：app :3100（`/api/public/runtime`）、mysql :3310；重建 `docker compose up -d --build app`；`zovocard-client.js` bind 实时。
- Xboard `xboard` :7001，后台 `/5fea4ca1`；custom_html 走 `tools/xboard-apply-custom-html.js`；**容器重建必重打内核补丁**（1/3/4；丢→充值下单 400「已售罄」；核查 grep `kc_is_topup`=1/2、`kcHasCardTable`=2；体检 `tools/test-topup-panel-flow.js`）。
- BEpusdt `bepusdt` :8080、卷 `D:/tools/bepusdt`；入口已 reset、登录须点按钮；**epay KEY=`api_auth_token`（32 位，勿混 64 位 `admin_secret`）**；签名=升序拼接+KEY→MD5；成功=302→`/pay/checkout/{trade_id}`。
- **收款钱包就绪**：唯一启用 usdt.trc20=`TSYdNdbx1Prw5jXjcWTgbY6N28BGmR1ufD`；回调 `http://172.17.0.1:7001/...`、return `localhost:7001/#/order/{trade_no}`。
- 凭据见 `.env`（集成密钥为联调值，收款前轮换）；入口：KC `:3100/admin-login`、Xboard `:7001/5fea4ca1`、BEpusdt `:8080/<新入口>`、KC `:3100/business-admin`（冻结）。

## KC 引擎
- ZovoCard 同构替换 `gpt-api-client.js`：`X-API-Key: sk_`、`code===0`、preflight、202 轮询、`spendable_balance`；`GPT_API_PLAN_MAP`；SOCKS5 `ZOVOCARD_PROXY`（出口 216.223.16.210）。
- 表 `app_config`/`cdk_codes`/`task_logs`(job_key UNI)/`integration_cdk_issue`(ref UNI)。⭐ 并发抢占必须 `INSERT IGNORE`。

## 对外集成（Xboard→KC）
- `POST /api/integration/cdk/issue`（幂等）+ GET 回查 + health；头 `X-Integration-Key`；响应 `{success,data:{ref,cdk,plan_type,reused}}`；CDK `type='自助'`；发卡挂 `order.open.after`。✅ v1.11.1 全绿；v1.11.3 补回 S8 健康摘要（`supplier-health.js`，`/health` 带 `supplier_health`、商城据此判可售、刷新仅 Mock）+ 履约链路模拟验证通过。

## Xboard 平台真相
- `ghcr.io/cedar2025/xboard`（Octane）：前台 hash 路由、仅 12 页、无钱包页；金额「分」；custom_html 在 `#app` 外；`v2_settings` 无 key 列；补列 `kc_is_topup`/`kc_topup_amount`/`kc_card`。
- 支付：渠道 `v2_payment`；EPay=plugins-core 定制插件（尾数/KC 台账）；回调 `/api/v1/guest/payment/notify/{method}/{uuid}`；「订单不存在」误回 success（不动）。
- 红线（SP-2026-10-10）：只许 ①保命补丁 ②插件 API ③壳层菜单；`admin/kc/*` 12 接口（403=存活）。
- 坑：period 键错配；`plan/save` 不收 show/sell/renew/sort；余额=抵扣池（纯余额单 `OrderService->paid('BALANCE-..')`）；分销快照 `order.open.after`（20/10/5）；`/invite/save` 是 GET；插件 PascalCase 目录/snake code、`listen()`、路由无 `/api` 前缀、新增后 `octane:reload`、`order.open.after` 超时 5s→HTTP 2~3s 全吞。

## 前端注入 & 业务闭环
- 三源 `tools/kc_{theme,panel,activate}_inject.html`（含防中间态三件套；方法论→技能 `spa-inject-without-rebuild`）；充值主路径 `payment.notify.verified`→加余额+COMPLETED；下限三处同改（panel `MIN_USD`+theme+`TopupController`，现 $1）；用户 API 头用 `auth_data`。
- 独立轨道 Mock 冻结；迁移用 `biz_` 前缀；红线：`REQUIRE_ZOVOCARD_MOCK=1`/`ZOVOCARD_MOCK=1` 未批准不得解除；Session/Token/Cookie/密码/卡号不落库。
