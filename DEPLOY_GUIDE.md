# DEPLOY_GUIDE · KC-PAY-GPT 部署指南

> 服务清单的唯一来源是 **`deploy-manifest.json`**。新增/删除/改名服务**只改那一个文件**，Windows 与 Linux 两套脚本自动跟随。

---

## 一、环境要求

| 组件 | 要求 |
|---|---|
| Docker | Docker Desktop（Windows/macOS，WSL2 模式）或 Docker Engine（Linux） |
| Docker Compose | v2 插件（`docker compose`）；旧版 `docker-compose` 也兼容 |
| Node.js | ≥ 20（仅跑验收脚本时需要） |
| 内存 | ≥ 4 GB |

**Linux 部署脚本还需要 JSON 解析器**：`jq`（推荐）、`python3` 或 `node` 任一即可。三者都没有时脚本会明确报错。

---

## 二、文件清单

**双平台同名同动作**，按需双击或命令行执行：

| 文件 | Windows | Linux / macOS |
|---|---|---|
| 启动全部服务 | `start_20261007.bat` | `start_20261007.sh` |
| 停止全部服务 | `stop_20261007.bat` | `stop_20261007.sh` |
| 更新部署（拉取+重建） | `deploy_20261007.bat` | `deploy_20261007.sh` |
| 控制台菜单 | `console_20261007.bat` | `console_20261007.sh` |
| **引擎（被上面调用）** | `kc-deploy_20261007.ps1` | `kc-deploy_20261007.sh` |
| **服务清单** | `deploy-manifest.json` | `deploy-manifest.json` |

> ⚠️ **`.bat` 必须是 GBK(936) 编码 + CRLF 换行**。用 UTF-8 或 LF 保存会导致 cmd 解析错位（报 `'hell' 不是内部或外部命令`）和中文乱码。

---

## 三、最快上手（非技术用户）

**Windows**：双击 `start_20261007.bat`
**Linux/macOS**：先 `chmod +x *.sh`，再双击或 `./start_20261007.sh`

脚本会自动：启动 Docker（如未运行）→ 依次启动三个服务 → 等待健康检查 → 重放 Xboard 前端注入 → 显示状态 → 打开三个后台页面。

---

## 四、全部命令

```powershell
# Windows
.\kc-deploy_20261007.ps1            # 交互菜单
.\kc-deploy_20261007.ps1 start      # 启动全部
.\kc-deploy_20261007.ps1 stop       # 停止全部（保留数据）
.\kc-deploy_20261007.ps1 deploy     # 拉取最新 + 重建 + 启动
.\kc-deploy_20261007.ps1 inject     # 仅重放 Xboard 前端注入
.\kc-deploy_20261007.ps1 status     # 查看容器状态
.\kc-deploy_20261007.ps1 verify     # 自检：实际运行 vs 清单期望
.\kc-deploy_20261007.ps1 list       # 打印服务清单（不需 Docker）
```

```bash
# Linux / macOS（用法完全相同）
./kc-deploy_20261007.sh
./kc-deploy_20261007.sh start
./kc-deploy_20261007.sh stop
./kc-deploy_20261007.sh deploy
./kc-deploy_20261007.sh inject
./kc-deploy_20261007.sh status
./kc-deploy_20261007.sh verify
./kc-deploy_20261007.sh list
```

### 可选环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `XBOARD_DIR` | 指定 Xboard 目录（优先于自动搜索） | 自动搜索同级 `../Xboard`、`./Xboard`、`/opt/xboard` |
| `KC_DIR` | 指定 KC 项目目录 | 脚本自身所在目录 |
| `DOCKER_BIN` | 指定 docker 可执行文件 | `docker` |

---

## 五、服务构成

| 服务 | 类型 | 容器 | 宿主端口 | 访问地址 |
|---|---|---|---|---|
| **KC 代充引擎** | compose `kc-gpt-pay2` | `kc-gpt-pay2-app`<br>`kc-gpt-pay2-mysql` | 3100→3000<br>3310→3306 | 前台 `http://localhost:3100/`<br>后台 `http://localhost:3100/admin-login` |
| **Xboard 商城** | compose `xboard` | `xboard` | 7001→80 | 前台 `http://localhost:7001/`<br>后台 `http://localhost:7001/5fea4ca1` |
| **BEpusdt** | 独立容器 | `bepusdt` | 8080→8080 | 后台 `http://localhost:8080/0c09205c71` |

---

## 六、`verify` 自检：怎么发现"文档与实际不一致"

`verify` 会对比**清单期望的容器集合**与**实际运行的容器**，逐条标注：

| 标记 | 含义 |
|---|---|
| `[UP]` | 正常运行 |
| `[DOWN]` | 容器存在但已停止 → 用 `start` 启动 |
| `[MISS]` | 容器未创建 → 用 `start` 或 `deploy` 创建 |
| `[DRIFT]` | 在运行但不在清单里 → 可能是遗留容器，或清单漏登记 |

**出现 `[DRIFT]` 说明清单与实际已漂移**：要么清理多余容器，要么把它补进 `deploy-manifest.json`。

---

## 七、新增/删除服务（只需改一个文件）

在 `deploy-manifest.json` 的 `services` 数组里增删条目，然后跑 `verify` 确认结果。

**compose 类型服务**：

```json
{
  "id": "myservice",
  "name": "My Service",
  "type": "compose",
  "compose_path": "../myservice/docker-compose.yml",
  "project": "myservice",
  "containers": ["myservice"],
  "ports": ["9000:80"],
  "health_url": "http://localhost:9000/",
  "access_urls": ["http://localhost:9000/admin"],
  "requires_env": [],
  "build": false,
  "inject": false
}
```

**独立容器类型**（用 `docker run` 而非 compose）：

```json
{
  "id": "standalone-svc",
  "name": "Standalone Service",
  "type": "standalone",
  "image": "vendor/image:tag",
  "volume": "../data:/var/lib/data",
  "containers": ["standalone-svc"],
  "ports": ["9100:9100"],
  "health_url": "http://localhost:9100/",
  "access_urls": [],
  "requires_env": [],
  "build": false,
  "inject": false
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识 |
| `name` | ✅ | 显示名 |
| `type` | ✅ | `compose` 或 `standalone` |
| `containers` | ✅ | 容器名数组，`verify` 据此比对 |
| `ports` | ✅ | 端口映射；standalone 取第一个用于 `-p` |
| `health_url` | | 启动后等待此地址返回 2xx/4xx |
| `access_urls` | | `start`/`deploy` 完成后自动打开的页面 |
| `compose_path` | compose 必填 | 相对 `deploy-manifest.json` 所在目录 |
| `project` | compose 必填 | compose 项目名 |
| `image` / `volume` | standalone 必填 | 镜像与数据卷（`host:container`） |
| `requires_env` | | 缺失时给出警告的文件（如 `.env`） |
| `build` | | `deploy` 时是否 `--build` |
| `inject` | | 是否需要重放 Xboard 前端注入 |

改完务必跑一次 `verify` 确认期望集合正确。

---

## 八、常见问题

**Q：双击 `.bat` 报 `'hell' 不是内部或外部命令`？**
A：`.bat` 被保存成 UTF-8 或 LF 换行，cmd 解析错位。必须 **GBK(936) + CRLF**。

**Q：脚本报找不到 Xboard？**
A：设 `XBOARD_DIR` 环境变量指向 Xboard 目录，或把 Xboard 放在本项目同级目录。

**Q：Linux 报 `No JSON parser found`？**
A：装 `jq`（`apt install jq` / `brew install jq`），或确保有 `python3` 或 `node`。

**Q：改了什么需要重启？**
A：`server.js`、`mysql-store.js`、`public/` 需 `docker compose up -d --build app` 重建；`zovocard-client.js` 等 bind mount 文件实时生效。

**Q：Xboard 改了配置但前台没生效？**
A：必须 `php artisan optimize:clear` —— `admin_setting()` 会把配置读进 Laravel 缓存，只写数据库无效。脚本的 `inject` 动作已包含这一步。

**Q：`stop` 会丢数据吗？**
A：不会。`stop` 只停容器，数据库卷和配置都保留。

**Q：容器重建后 Xboard 功能异常？**
A：Xboard 容器内有两个补丁**重建必重打**（`PlanService.validatePlanAvailability` 加 kc_is_topup 豁免；`TopupController::prepare` 去掉 `AND p.show=1`）。详见 `tools/xboard-patches/README.md`。

---

## 九、相关文档

| 我想知道 | 看哪 |
|---|---|
| 系统有什么功能、用户怎么用、未来做什么 | `docs/产品全景.md` |
| 最近改了什么 | `CHANGELOG.md` 顶部第一条 |
| 开发规范与不可变约束 | `docs/开发规范.md` |
| 环境、待办、关键文件索引 | `docs/00_项目状态.md` |