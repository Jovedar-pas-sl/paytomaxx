# syntax=docker/dockerfile:1.7
# NightPay Operator (Next.js standalone) — app de la chica

FROM node:22.23.3-alpine3.24 AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
# Un package.json por proyecto del workspace (los importers de pnpm-lock.yaml),
# igual en las cuatro apps Next: si falta uno, --frozen-lockfile instala otro árbol.
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/e2e/package.json apps/e2e/
COPY apps/mock-peanpe/package.json apps/mock-peanpe/
COPY apps/mock-wipay/package.json apps/mock-wipay/
COPY apps/operator/package.json apps/operator/
COPY apps/tpv/package.json apps/tpv/
COPY apps/web-client/package.json apps/web-client/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY packages/contracts ./packages/contracts
COPY packages/config ./packages/config
# packages/ui: componentes, estilos y las fuentes (next/font/local, sin Google).
COPY packages/ui ./packages/ui
COPY apps/operator ./apps/operator
ENV NEXT_BUILD_TRACE_ROOT=/repo
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* se hornean al compilar: quedan dentro del JS y de las cabeceras
# (CSP connect-src). Cambiarlas en el contenedor ya construido no hace nada: para
# otro dominio, build args NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL en Dokploy y
# reconstruir. Los valores por defecto son los de producción (Dokploy cuenta con ellos).
ARG NEXT_PUBLIC_API_URL=https://api.paytomaxx.com
ARG NEXT_PUBLIC_WS_URL=wss://api.paytomaxx.com
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
RUN pnpm --filter @nightpay/operator build

FROM node:22.23.3-alpine3.24 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4104
ENV HOSTNAME=0.0.0.0

COPY --from=builder --chown=node:node /repo/apps/operator/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/operator/.next/static ./apps/operator/.next/static
COPY --from=builder --chown=node:node /repo/apps/operator/public ./apps/operator/public

EXPOSE 4104

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4104',{timeout:4000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"

# Sin root: si alguien encuentra un fallo en la web, no manda en el contenedor.
USER node
CMD ["node", "apps/operator/server.js"]
