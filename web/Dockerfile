# ============================================================
# KC 前台（Next.js）— 生产镜像
#
# 与 KC 代充引擎（kc-gpt-pay2-app）分开构建、分开部署。
# 后端地址由 XBOARD_ORIGIN 注入，用于服务端转发接口。
# ============================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund


FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0

# standalone 产物自带精简的 node_modules 与服务入口
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3001

CMD ["node", "server.js"]
