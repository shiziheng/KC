# MEMORY · KC-PAY-GPT

> 状态看 docs/00_项目状态.md；当日写 .workbuddy/memory/YYYY-MM-DD.md。

## 协作与文档
- 节奏：方案→计划→分段执行，每段停下等确认；开场读 README→docs/产品全景.md→CHANGELOG 顶→本文件。
- 版本规范六步（见 docs/开发规范.md）：版本号→代码→同步全景→自测→CHANGELOG→入口；CHANGELOG 只追加；产品全景=能力唯一正本；闸门 check-docs-sync+pre-commit。
- 架构基线：后台形态=分层 C（2026-10-11 确认）：运营台自建+内核借壳少改；契约 docs/接口/运营台契约-v1.md。

## ⚠️ Git 铁律
- 未提交内容绝不 reset --hard/stash/clean -fd；破坏性测试用临时副本；留底 tools/git-safe.js snapshot。
- 重建仓库报 invalid object → 删 .git/index 再 add；git 中文路径输出 GBK；提交前 git status、分组 add；身份 KC-CatK <iamkc1110@gmail.com>。

## 本机环境坑
- Bash 无 coreutils → 用 .js+node 跑、输出落文件再 Read；docker 用全路径；npm 静默失败 → npm-cli.js 全路径 install。
- PowerShell stdout 不回显、杀进程 taskkill /F /PID；headless 用一次性 profile；.bat 要 GBK+CRLF；中文 md 扫 \uFFFD；监听 0.0.0.0；容器内 mysql 用 bash -c。
- ⭐.ps1 新增块必须 ASCII（PS5.1 读无 BOM 中文注释会吞换行致解析错，实测）；校验用 Parser::ParseFile / PortableGit bash -n（容器 busybox sh 会误报 bash 语法）。
- 凭据输出易被审批拦截 → 用户自跑/在场授权；密钥脚本内用、绝不打印。
- 同文件多处 Edit 别同批（会丢改动）；改后 node includes 复核。

## 部署与运行（deploy-manifest.json=服务清单）
- KC kc-gpt-pay2：app :3100（探活 /api/public/runtime）、mysql :3310；重建 docker compose up -d --build app；zovocard-client.js bind 实时。
- Xboard :7001（后台 /5fea4ca1）；custom_html 走 tools/xboard-apply-custom-html.js；容器重建必重打内核补丁（丢→下单 400 已售罄）——已并入引擎自动核查+重打（tools/xboard-patch-check.js，ps1 委托 node）。
- BEpusdt :8080、卷 D:/tools/bepusdt；epay KEY=api_auth_token（32 位，勿混 64 位 admin_secret）；签名=升序拼+KEY→MD5；成功=302→/pay/checkout/{trade_id}。
- 收款钱包就绪：唯一启用 usdt.trc20=TSYdNdbx1Prw5jXjcWTgbY6N28BGmR1ufD；回调 172.17.0.1:7001。
- 凭据见 .env（收款前轮换）；入口：KC :3100/admin-login、business-admin（冻结）。

## KC 引擎
- ZovoCard 同构替换 gpt-api-client.js：X-API-Key: sk_、code===0、preflight、202 轮询、spendable_balance；GPT_API_PLAN_MAP；SOCKS5 ZOVOCARD_PROXY。
- 表 app_config / cdk_codes / task_logs(job_key UNI) / integration_cdk_issue(ref UNI)；⭐并发抢占必须 INSERT IGNORE。

## 对外集成（Xboard→KC）
- POST /api/integration/cdk/issue（幂等）+GET 回查+health；头 X-Integration-Key；响应 {success,data:{ref,cdk,plan_type,reused}}；CDK type=自助；发卡挂 order.open.after。
- v1.11.3 补回 S8 健康摘要（supplier-health.js；/health 带 supplier_health，商城据此判可售，刷新仅 Mock）。

## Xboard 平台真相
- ghcr.io/cedar2025/xboard（Octane）：hash 路由、仅 12 页、无钱包页；金额以分计；custom_html 在 #app 外；v2_settings 无 key 列；补列 kc_is_topup / kc_topup_amount / kc_card。
- 支付渠道 v2_payment；EPay=plugins-core 定制插件；回调 /api/v1/guest/payment/notify/{method}/{uuid}；「订单不存在」误回 success（不动）。
- 红线：只许 ①保命补丁 ②插件 API ③壳层菜单；admin/kc/* 18 接口（403=存活）。壳页(ops/support)公开壳+数据接口 admin 鉴权，token 取同源 localStorage。
- 坑：period 键错配；plan/save 不收 show/sell/renew/sort；余额=抵扣池（纯余额单 OrderService->paid('BALANCE-..')）；分销快照 order.open.after（20/10/5）；/invite/save 是 GET；插件 PascalCase 目录/snake code、listen()、路由无 /api 前缀、新增后 octane:reload；order.open.after 5s 超时内 HTTP 2~3s 全吞。
- 插件配置有 1h Cache::remember（octane:reload 不清）→ 要即时生效的配置键直读 DB（如 card_buy_*）。

## 前端注入 & 业务闭环
- 三源 tools/kc_{theme,panel,activate}_inject.html（防中间态三件套；技能 spa-inject-without-rebuild）；充值主路径 payment.notify.verified→加余额+COMPLETED；下限三处同改（现 $1）；用户 API 头用 auth_data。
- 「购买卡密」P1（v1.12.0）；客服工作台 /plugins/kc_integration/support（只读聚合+话术卡；接口 admin/kc/support/*）。
- 货币守护：全站 $（兜底+check-currency.js+钩子）；收银台 CNY 为定价层边界。
- 独立轨道 Mock 冻结；迁移用 biz_ 前缀；红线：ZOVOCARD_MOCK=1 / REQUIRE_ZOVOCARD_MOCK=1 未批准不得解除；Session/Token/Cookie/密码/卡号不落库。
