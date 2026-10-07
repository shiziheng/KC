# KC 前台（Next.js）

用户可见的商城前台。**替代 Xboard 的原生前台**，后端（用户/订单/支付/余额）继续由 Xboard 提供。

## 与后端的关系

```
浏览器
  │  https://你的域名
  ▼
本服务（Next.js, :3001）
  ├── 页面渲染
  └── /api/xb/*  /api/pg/*  ──服务端转发──▶  Xboard (:7001)
                                                  │
                                                  │ CDK 契约
                                                  ▼
                                              KC 代充引擎 (:3100)
```

- `/api/xb/*` → Xboard 标准接口（`/api/v1/...`）
- `/api/pg/*` → Xboard 插件路由（无 `/api` 前缀，如 `/plan/kc-cards`）

转发由 `next.config.mjs` 的 `rewrites` 完成，因此**浏览器只跟本服务通信，不存在跨域问题**，Xboard 也无需任何改造。

后端地址由环境变量控制（默认 `http://localhost:7001`）：

```bash
XBOARD_ORIGIN=http://xboard:7001
```

## 开发

> ⚠️ 本机环境限制：`npm` 不能直接用，需通过 node 调用 npm-cli。

```bash
# 安装依赖（用淘宝源，官方源的 next 元数据有 30MB，很慢）
node "$NODE_DIR/node_modules/npm/bin/npm-cli.js" install \
  --registry=https://registry.npmmirror.com --no-audit --no-fund

# 开发模式（:3001）
node "$NODE_DIR/node_modules/npm/bin/npm-cli.js" run dev

# 生产构建
node "$NODE_DIR/node_modules/npm/bin/npm-cli.js" run build

# 类型检查
node "$NODE_DIR/node_modules/npm/bin/npm-cli.js" run typecheck
```

其中 `$NODE_DIR` = `C:/Users/shizi/.workbuddy/binaries/node/versions/22.22.2-3`

## 目录结构

```
app/
  layout.tsx        根布局（顶栏 + 内容 + 底栏）
  globals.css       基础样式 + 组件类
  page.tsx          首页
  plan/             商品页
  order/            我的订单
  topup/            余额充值
  login/            登录 / 注册
components/
  Topbar.tsx        顶栏（含移动端抽屉）
  Footer.tsx        底栏
  Placeholder.tsx   占位页（未实现的路由用）
tailwind.config.ts  设计基线（配色 / 字号 / 圆角）
```

## 设计基线

改配色只改 `tailwind.config.ts` 一处，所有页面跟着变。

| token | 值 | 用途 |
|---|---|---|
| `brand` | `#0d9488` | 主品牌色 |
| `brand-deep` | `#085041` | 深色块 |
| `page` | `#f6f8fa` | 页面底色 |
| `t1` / `t2` / `t3` | 三档文字色 | 标题 / 正文 / 辅助 |

组件类（`globals.css`）：`.kc-container` `.kc-card` `.kc-btn` `.kc-tag` `.kc-input`

## 部署

```bash
docker build -t kc-web .
docker run -d -p 3001:3001 -e XBOARD_ORIGIN=http://xboard:7001 kc-web
```

需要与 Xboard 处于同一 Docker 网络（`xboard_default`）才能用容器名互相访问。

## 执行计划

分六段推进，每段完成后停下确认：

| 段 | 内容 | 状态 |
|---|---|---|
| 0 | 骨架 + 设计基线 + 响应式 | ✅ 已完成 |
| 1 | 用户体系（注册 / 登录 / 改密） | 待开始 |
| 2 | 商品页 + 代充向导（核心） | 待开始 |
| 3 | 余额 / 充值 / 订单 | 待开始 |
| 4 | 兑卡与代充进度 | 待开始 |
| 5 | 域名 + HTTPS + 切换 | 待开始 |

详见 `../docs/计划/前台自建_分段执行计划.md`
