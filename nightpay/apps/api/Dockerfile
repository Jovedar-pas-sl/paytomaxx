# syntax=docker/dockerfile:1.7
# OxioPay / NightPay API — TypeScript ejecutado con tsx (sin compilar: evita
# líos de resolución de módulos en el monorepo; los @nightpay/* se resuelven
# por los enlaces de pnpm, como en desarrollo).
#
# Una sola etapa a propósito: en tiempo de ejecución hacen falta paquetes que
# son devDependencies (tsx para arrancar, el CLI de prisma para las
# migraciones), así que una etapa final "--prod" no arrancaría. Lo que sí se
# recorta: solo se instala el API y lo que usa (@nightpay/db, contracts,
# config), no las webs Next ni Playwright.

# Versión fija (la misma de nightpay/.nvmrc). Al subirla, cambiar las dos.
FROM node:22.23.3-alpine3.24

# openssl + libc6-compat para que Prisma engines funcionen en Alpine
RUN apk add --no-cache openssl libc6-compat

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# 1. Dependencias. El lockfile manda (--frozen-lockfile): si no cuadra con los
#    package.json, el build falla en vez de instalar otra cosa. Se copian los
#    manifiestos de TODOS los proyectos del workspace (los "importers" del
#    lockfile) para que pnpm vea el mismo workspace que en desarrollo.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/e2e/package.json apps/e2e/
COPY apps/mock-peanpe/package.json apps/mock-peanpe/
COPY apps/mock-wipay/package.json apps/mock-wipay/
COPY apps/operator/package.json apps/operator/
COPY apps/tpv/package.json apps/tpv/
COPY apps/web-client/package.json apps/web-client/
COPY packages/api-client/package.json packages/api-client/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile --filter "@nightpay/api..."

# 2. Código fuente (TS, no se compila). prisma/seed.ts no entra (.dockerignore).
COPY packages ./packages
COPY apps/api ./apps/api

# 3. Cliente de Prisma en packages/db/src/generated (donde lo importa db/src/index.ts)
RUN pnpm --filter @nightpay/db generate

# Qué versión corre: /v1/health lo enseña (y Sentry lo usa de release).
# Dokploy: Build Args GIT_SHA=<commit> y, si quieres, BUILD_MARKER=<etiqueta>.
ARG GIT_SHA=""
ARG BUILD_MARKER=""
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_MARKER=${BUILD_MARKER}

WORKDIR /repo/apps/api
ENV NODE_ENV=production
ENV PORT=4100
EXPOSE 4100

# Healthcheck via Node http module — IPv4 explícito (evita el bug
# de wget en Alpine resolviendo localhost a ::1). Pega en /v1/health/live:
# solo "el proceso responde". /v1/health (DB + Redis) da 503 si algo cae y es
# para los monitores externos; aquí reiniciaría el API en bucle sin arreglar nada.
HEALTHCHECK --interval=30s --timeout=8s --start-period=45s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:4100/v1/health/live',{timeout:6000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"

# Sin root: si alguien encuentra un fallo en el API, no manda en el contenedor.
# El código queda de root y solo de lectura para el proceso.
USER node

# Al arrancar:
#   1. db-heal: avisa de migraciones fallidas (no cambia nada; ver el script).
#   2. prisma migrate deploy: aplica las que falten. Si una falla, el API no
#      arranca (mejor eso que arrancar con la base a medias).
#   3. db-heal otra vez: avisos de solo lectura sobre la base ya migrada.
#   4. exec node: Node pasa a ser el PID 1 y recibe él el SIGTERM de Docker
#      (Dokploy al redesplegar o parar) para cerrar ordenadamente.
CMD ["sh", "-c", "cd /repo/packages/db && ./node_modules/.bin/tsx scripts/db-heal.ts && ./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/tsx scripts/db-heal.ts && cd /repo/apps/api && exec node --import tsx src/main.ts"]
