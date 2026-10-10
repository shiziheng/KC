# CHANGELOG · KC-PAY-GPT

> **本文件是版本记录的唯一正本，只追加、不覆写。**
> **最新版本永远在最顶部 —— 读第一个条目即可，不需要搜索。**
> 配套规范见 `docs/开发规范.md`；入口见 `README.md` 顶部「开发协作入口」。

格式：`v主版本.次版本.修订号 · 日期 · 一句话标题`
新增功能升次版本，修 bug 升修订号，架构重写升主版本。

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
