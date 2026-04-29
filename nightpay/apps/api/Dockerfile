# syntax=docker/dockerfile:1.7
# NightPay API — multi-stage build para pnpm monorepo

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ─── deps: instala node_modules (cacheable) ─────────────────────────
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

# ─── builder: genera Prisma + compila API ────────────────────────────
FROM deps AS builder
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @nightpay/db generate
RUN pnpm --filter @nightpay/api build

# ─── runner: imagen final minima ─────────────────────────────────────
FROM node:20-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# Copiar solo lo imprescindible
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/apps/api/package.json ./apps/api/
COPY --from=builder /repo/pnpm-workspace.yaml ./
COPY --from=builder /repo/package.json ./

WORKDIR /repo/apps/api
ENV NODE_ENV=production
ENV PORT=4100
EXPOSE 4100

# Healthcheck (Dokploy lo respeta)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:4100/v1/health || exit 1

CMD ["node", "dist/main.js"]
