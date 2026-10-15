#!/usr/bin/env bash
# restore-check — ¿se puede restaurar esta copia de la base?
#
# Restaura una copia (la de Dokploy, la de restic o un pg_dump a mano) en una
# base DE USAR Y TIRAR y comprueba que tiene cobros, saldos y comisiones. No
# toca la base de producción ni ningún volumen de Docker.
#
#   scripts/restore-check.sh <copia>                  Postgres 16 temporal en Docker
#   scripts/restore-check.sh <copia> --url <postgres> en una base VACÍA ya creada
#                                                     (necesita pg_restore y psql)
#
# <copia>: formato propio de pg_dump (-Fc) o SQL plano, con o sin gzip
# (las de Dokploy acaban en .sql.gz pero son -Fc comprimidas).
#
# Mínimos (por defecto 1; 0 = no exigir):
#   MIN_PAYMENTS, MIN_CLIENT_WALLETS, MIN_OPERATOR_EARNINGS
# Antigüedad máxima del último cobro, en días (por defecto sin límite):
#   MAX_LAST_PAYMENT_AGE_DAYS
#
# Sale con 0 si todo cuadra; con 1 si la copia no se restaura o le faltan datos.
set -euo pipefail

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
fail() { echo "[restore-check] FALLO: $*" >&2; exit 1; }

DUMP="${1:-}"
[ -n "$DUMP" ] && [ "$DUMP" != "-h" ] && [ "$DUMP" != "--help" ] || usage
[ -f "$DUMP" ] || fail "no encuentro la copia: $DUMP"
shift
URL=""
if [ "${1:-}" = "--url" ]; then
  URL="${2:-}"
  [ -n "$URL" ] || fail "--url sin valor"
fi

MIN_PAYMENTS="${MIN_PAYMENTS:-1}"
MIN_CLIENT_WALLETS="${MIN_CLIENT_WALLETS:-1}"
MIN_OPERATOR_EARNINGS="${MIN_OPERATOR_EARNINGS:-1}"
MAX_AGE="${MAX_LAST_PAYMENT_AGE_DAYS:-}"

# ¿gzip? ¿formato propio de pg_dump (empieza por "PGDMP") o SQL plano?
reader=(cat "$DUMP")
if [ "$(head -c 2 "$DUMP" | od -An -tx1 | tr -d ' \n')" = "1f8b" ]; then
  reader=(gzip -dc "$DUMP")
fi
magic="$("${reader[@]}" 2>/dev/null | head -c 5 || true)"
if [ "$magic" = "PGDMP" ]; then FORMAT=custom; else FORMAT=sql; fi
echo "[restore-check] copia: $DUMP ($(du -h "$DUMP" | cut -f1), formato $FORMAT)"

CONTAINER=""
cleanup() { [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -z "$URL" ]; then
  command -v docker >/dev/null || fail "hace falta Docker (o usa --url con una base vacía)"
  CONTAINER="restore-check-$$"
  # Sin volumen: la base vive dentro del contenedor y desaparece con él.
  docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=restore-check \
    -e POSTGRES_DB=nightpay postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U postgres -d nightpay >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$CONTAINER" pg_isready -U postgres -d nightpay >/dev/null 2>&1 || fail "el Postgres temporal no arrancó"
  # La imagen marca "listo" un momento antes de su reinicio final: margen.
  sleep 2
  run_psql() { docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d nightpay "$@"; }
  run_restore() { docker exec -i "$CONTAINER" pg_restore --no-owner --no-acl -U postgres -d nightpay; }
else
  command -v psql >/dev/null && command -v pg_restore >/dev/null || fail "con --url hacen falta psql y pg_restore"
  run_psql() { psql -X -v ON_ERROR_STOP=1 "$URL" "$@"; }
  run_restore() { pg_restore --no-owner --no-acl -d "$URL"; }
  # Nunca encima de una base con datos (p. ej. la de producción por error).
  existing="$(run_psql -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
  [ "$existing" = "0" ] || fail "la base de --url no está vacía ($existing tablas): usa una base nueva de usar y tirar"
fi

echo "[restore-check] restaurando…"
start=$(date +%s)
if [ "$FORMAT" = "custom" ]; then
  # pg_restore se queja de cosas sin importancia (dueños, extensiones ya
  # creadas); lo que cuenta es lo que hay al final.
  "${reader[@]}" | run_restore || echo "[restore-check] pg_restore terminó con avisos (se comprueba lo restaurado)"
else
  "${reader[@]}" | run_psql -q >/dev/null
fi
echo "[restore-check] restaurada en $(( $(date +%s) - start )) s"

# Como superusuario/dueño y con el bypass de RLS puesto: que no esconda filas.
counts="$(run_psql -tA -F ' ' <<'SQL'
SET app.bypass_rls = 'on';
SELECT (SELECT count(*) FROM payments),
       (SELECT count(*) FROM client_wallets),
       (SELECT count(*) FROM operator_earnings),
       (SELECT COALESCE(to_char(max("createdAt") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'), '-') FROM payments),
       (SELECT COALESCE(floor(extract(epoch FROM now() - max("createdAt")) / 86400)::int, -1) FROM payments),
       (SELECT COALESCE(max(migration_name), '-') FROM _prisma_migrations WHERE finished_at IS NOT NULL);
SQL
)" || fail "la copia no tiene las tablas de OxioPay (¿es la base correcta?)"
counts="$(printf '%s\n' "$counts" | grep -E '^[0-9]+ ' | tail -1)"
read -r payments wallets earnings last_payment age_days last_migration <<<"$counts"

echo "[restore-check] payments=$payments client_wallets=$wallets operator_earnings=$earnings"
echo "[restore-check] último cobro: $last_payment (hace $age_days días) · última migración: $last_migration"

problems=0
check_min() {
  if [ "$2" -lt "$3" ]; then echo "[restore-check] FALLO: $1 = $2 (mínimo $3)" >&2; problems=$((problems + 1)); fi
}
check_min payments "$payments" "$MIN_PAYMENTS"
check_min client_wallets "$wallets" "$MIN_CLIENT_WALLETS"
check_min operator_earnings "$earnings" "$MIN_OPERATOR_EARNINGS"
if [ -n "$MAX_AGE" ] && [ "$age_days" -gt "$MAX_AGE" ]; then
  echo "[restore-check] FALLO: el último cobro es de hace $age_days días (máximo $MAX_AGE)" >&2
  problems=$((problems + 1))
fi
[ "$problems" -eq 0 ] || exit 1
echo "[restore-check] OK: la copia se restaura y tiene datos"
