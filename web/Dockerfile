FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

ARG XBOARD_ORIGIN=http://host.docker.internal:7001
ARG KC_API_ORIGIN=http://app:3000
ENV XBOARD_ORIGIN=${XBOARD_ORIGIN}
ENV KC_API_ORIGIN=${KC_API_ORIGIN}
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
