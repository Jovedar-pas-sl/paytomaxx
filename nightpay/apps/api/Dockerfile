# syntax=docker/dockerfile:1.7
# NightPay API — runtime tsx (sin compilar, evita problemas de monorepo + module resolution)
#
# Filosofia: tsx ejecuta TypeScript directamente. Workspace deps (@nightpay/*)
# resueltas por symlinks pnpm como en dev. Tradeoff: ~50ms startup mas, ~100MB
# imagen mas grande. Acceptable para tool interno de 5 usuarios.

FROM node:22-alpine

# openssl + libc6-compat para que Prisma engines funcionen en Alpine
RUN apk add --no-cache openssl libc6-compat

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

# Healthcheck via Node http module — IPv4 explícito (evita el bug
# de wget en Alpine resolviendo localhost a ::1). Pega en /v1/health
# que ya verifica DB + Redis.
HEALTHCHECK --interval=30s --timeout=8s --start-period=45s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:4100/v1/health',{timeout:6000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"

# Aplicar migraciones prisma antes de arrancar el API.
# 1) db-heal: marca migraciones colgadas como resueltas + asegura columnas críticas
#    con ADD COLUMN IF NOT EXISTS. Idempotente. Sin esto, una migración a medio
#    aplicar bloquea TODOS los deploys siguientes.
# 2) migrate deploy: aplica las pendientes (no toca las ya marcadas)
# 3) exec tsx: reemplaza sh por Node como PID 1 → SIGTERM llega correctamente
CMD ["sh", "-c", "cd /repo && pnpm --filter @nightpay/db exec tsx scripts/db-heal.ts && pnpm --filter @nightpay/db exec prisma migrate deploy && cd /repo/apps/api && exec ./node_modules/.bin/tsx src/main.ts"]
