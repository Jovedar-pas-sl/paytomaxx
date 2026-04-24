#!/usr/bin/env bash
# NightPay — verify Sprint 1 milestone
# Uso: ./scripts/verify-sprint1.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

PASS=0
FAIL=0
check() {
    local label="$1"; shift
    printf "  %-50s " "$label"
    if "$@" >/dev/null 2>&1; then
        printf '\033[32mOK\033[0m\n'
        PASS=$((PASS+1))
    else
        printf '\033[31mFAIL\033[0m\n'
        FAIL=$((FAIL+1))
    fi
}

echo "── Sprint 1 acceptance checks ──"
echo

echo "[tooling]"
check "node >= 20"          bash -c '[[ "$(node -v | sed "s/v//" | cut -d. -f1)" -ge 20 ]]'
check "pnpm installed"      command -v pnpm
check "docker available"    command -v docker

echo
echo "[workspace structure]"
check "package.json root"         test -f package.json
check "pnpm-workspace.yaml"       test -f pnpm-workspace.yaml
check "turbo.json"                test -f turbo.json
check ".env.example present"      test -f .env.example
check ".gitignore present"        test -f .gitignore

echo
echo "[apps]"
for app in api web-client tpv admin mock-wipay mock-peanpe; do
    check "apps/$app/package.json"  test -f "apps/$app/package.json"
    check "apps/$app/tsconfig.json" test -f "apps/$app/tsconfig.json"
done

echo
echo "[packages]"
for pkg in config contracts db; do
    check "packages/$pkg/package.json" test -f "packages/$pkg/package.json"
done
check "packages/db/prisma/schema.prisma" test -f packages/db/prisma/schema.prisma
check "packages/db/prisma/seed.ts"       test -f packages/db/prisma/seed.ts

echo
echo "[docker & CI]"
check "docker-compose.yml"             test -f docker-compose.yml
check ".github/workflows/ci.yml"       test -f .github/workflows/ci.yml

echo
echo "[docs]"
check "docs/MASTER_PLAN_V2.md"         test -f docs/MASTER_PLAN_V2.md
check "docs/adr/ADR-001-*"             bash -c 'ls docs/adr/ADR-001-*.md 2>/dev/null'

echo
echo "[runtime — requiere pnpm install + docker compose up]"
check "Postgres reachable :5432"       bash -c 'echo > /dev/tcp/localhost/5432'
check "Redis reachable :6379"          bash -c 'echo > /dev/tcp/localhost/6379'
check "API /v1/health 200"             bash -c 'curl -sf http://localhost:3100/v1/health'

echo
echo "── Summary ──"
echo "  PASS: $PASS    FAIL: $FAIL"
echo
if [[ $FAIL -eq 0 ]]; then
    echo -e "\033[32mHito Sprint 1 alcanzado.\033[0m"
    exit 0
else
    echo -e "\033[33mFaltan pasos. Ejecuta: ./scripts/bootstrap.sh && pnpm dev\033[0m"
    exit 1
fi
