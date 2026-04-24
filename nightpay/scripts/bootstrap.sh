#!/usr/bin/env bash
set -euo pipefail

# NightPay — bootstrap de entorno local
# Uso: ./scripts/bootstrap.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*"; exit 1; }

say "NightPay bootstrap (dir: $HERE)"

command -v docker >/dev/null 2>&1 || die "docker no encontrado"
command -v pnpm >/dev/null 2>&1 || die "pnpm no encontrado — instalar con 'corepack enable && corepack prepare pnpm@9.12.0 --activate'"
command -v node >/dev/null 2>&1 || die "node no encontrado"

NODE_V="$(node -v)"
case "$NODE_V" in
  v20.*|v22.*) ;;
  *) warn "Node $NODE_V — recomendado v20 LTS" ;;
esac

if [[ ! -f .env.local ]]; then
  say "Creando .env.local a partir de .env.example"
  cp .env.example .env.local
  warn "Edita .env.local con valores reales antes de producción"
fi

say "Levantando Docker (postgres, redis, mocks)"
docker compose up -d postgres redis

say "Esperando DB saludable..."
for i in {1..30}; do
  if docker compose exec -T postgres pg_isready -U np >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

say "Instalando deps"
pnpm install --frozen-lockfile || pnpm install

say "Generando cliente Prisma"
pnpm --filter @nightpay/db generate

say "Aplicando migraciones (dev)"
pnpm --filter @nightpay/db migrate:dev -- --name init || true

say "Seed de datos demo"
pnpm --filter @nightpay/db seed || warn "Seed falló — revisa manualmente"

say "Levantando mocks pasarela"
docker compose up -d mock-wipay mock-peanpe || warn "Mocks opcionales — requieren build Docker"

cat <<EOF

✓ Bootstrap completo.

Siguiente paso:
  pnpm dev           # arranca api + 3 frontends en paralelo
  pnpm --filter @nightpay/api dev
  pnpm --filter @nightpay/web-client dev

Verificación:
  curl http://localhost:3100/v1/health
  abrir http://localhost:3101  (web-client)
  abrir http://localhost:3102  (tpv)
  abrir http://localhost:3103  (admin)
EOF
