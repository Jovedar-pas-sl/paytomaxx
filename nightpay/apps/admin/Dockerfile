# syntax=docker/dockerfile:1.7
# NightPay Admin (Next.js standalone)

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/mock-wipay/package.json apps/mock-wipay/
COPY apps/mock-peanpe/package.json apps/mock-peanpe/
COPY apps/admin/package.json apps/admin/
COPY apps/tpv/package.json apps/tpv/
COPY apps/web-client/package.json apps/web-client/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY packages/contracts ./packages/contracts
COPY packages/config ./packages/config
COPY apps/admin ./apps/admin
ENV NEXT_BUILD_TRACE_ROOT=/repo
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* variables se inyectan en build-time (no runtime)
ENV NEXT_PUBLIC_API_URL=https://api.paytomaxx.com
ENV NEXT_PUBLIC_WS_URL=wss://api.paytomaxx.com
RUN pnpm --filter @nightpay/admin build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4103
ENV HOSTNAME=0.0.0.0

# Standalone output incluye solo lo necesario
COPY --from=builder /repo/apps/admin/.next/standalone ./
COPY --from=builder /repo/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=builder /repo/apps/admin/public ./apps/admin/public

EXPOSE 4103
CMD ["node", "apps/admin/server.js"]
