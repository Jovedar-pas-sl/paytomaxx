# syntax=docker/dockerfile:1.7
# NightPay API — runtime tsx (sin compilar, evita problemas de monorepo + module resolution)
#
# Filosofia: tsx ejecuta TypeScript directamente. Workspace deps (@nightpay/*)
# resueltas por symlinks pnpm como en dev. Tradeoff: ~50ms startup mas, ~100MB
# imagen mas grande. Acceptable para tool interno de 5 usuarios.

FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# 1. Instalar deps (NO usar --frozen-lockfile en monorepo si lockfile cambia)
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

# 2. Copiar codigo fuente (TS, no compilamos)
COPY packages ./packages
COPY apps/api ./apps/api

# 3. Generar Prisma client en src/generated (donde db/src/index.ts lo importa)
RUN pnpm --filter @nightpay/db generate

WORKDIR /repo/apps/api
ENV NODE_ENV=production
ENV PORT=4100
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD wget -qO- http://localhost:4100/v1/health || exit 1

# tsx ejecuta TS directo. node_modules/.bin/tsx existe tras pnpm install.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
