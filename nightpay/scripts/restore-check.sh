#!/usr/bin/env bash
# restore-check — ¿se puede restaurar esta copia de la base?
#
# Restaura una copia (la de Dokploy, la de restic o un pg_dump a mano) en una
# base DE USAR Y TIRAR y comprueba esquema, restricciones, migraciones, una
# coherencia mínima del dinero y que tiene cobros, saldos y comisiones. No
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
# Sale con 0 si todo cuadra; con 1 si la copia no se restaura entera o le faltan datos.
set -euo pipefail

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
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
# Las migraciones del repositorio (si el guion corre desde él): ninguna anterior
# a la última restaurada puede faltar.
MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/packages/db/prisma/migrations"

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
  run_restore() { docker exec -i "$CONTAINER" pg_restore --exit-on-error --no-owner --no-acl -U postgres -d nightpay; }
else
  command -v psql >/dev/null && command -v pg_restore >/dev/null || fail "con --url hacen falta psql y pg_restore"
  run_psql() { psql -X -v ON_ERROR_STOP=1 "$URL" "$@"; }
  run_restore() { pg_restore --exit-on-error --no-owner --no-acl -d "$URL"; }
  # Nunca encima de una base con datos (p. ej. la de producción por error).
  existing="$(run_psql -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
  [ "$existing" = "0" ] || fail "la base de --url no está vacía ($existing tablas): usa una base nueva de usar y tirar"
fi

echo "[restore-check] restaurando…"
start=$(date +%s)
# Cualquier error corta (dueños y permisos ya se omiten a propósito): una
# restauración a medias puede tener filas en las tablas principales y aun así
# no servir.
if [ "$FORMAT" = "custom" ]; then
  "${reader[@]}" | run_restore || fail "pg_restore falló: la restauración está incompleta"
else
  "${reader[@]}" | run_psql -q >/dev/null || fail "psql falló al restaurar el SQL: la restauración está incompleta"
fi
echo "[restore-check] restaurada en $(( $(date +%s) - start )) s"

# 1) Esquema: un dump solo de datos o sin post-data puede tener filas pero
#    carecer de las garantías de integridad. Un mínimo estable, no el HEAD.
schema_ok="$(run_psql -qtA <<'SQL'
-- restore-schema
SELECT
  NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('payments', 'id'), ('payments', 'tenantId'), ('payments', 'status'),
      ('payments', 'amountCents'), ('payments', 'tipCents'), ('payments', 'availableAmountCents'),
      ('payments', 'createdAt'),
      ('client_wallets', 'id'), ('client_wallets', 'tenantId'), ('client_wallets', 'balanceCents'),
      ('refunds', 'paymentId'), ('refunds', 'amountCents'), ('refunds', 'status'),
      ('operator_earnings', 'id'), ('operator_earnings', 'tenantId'), ('operator_earnings', 'commissionCents')
    ) AS required(tbl, col)
    WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = required.tbl AND c.column_name = required.col)
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('payments', 'payments_pkey'), ('payments', 'payments_tenantId_fkey'),
      ('client_wallets', 'client_wallets_pkey'), ('client_wallets', 'client_wallets_tenantId_fkey'),
      ('client_wallets', 'client_wallets_balance_nonneg'),
      ('refunds', 'refunds_pkey'), ('refunds', 'refunds_paymentId_fkey'),
      ('operator_earnings', 'operator_earnings_pkey'),
      ('operator_earnings', 'operator_earnings_tenantId_fkey'),
      ('operator_earnings', 'operator_earnings_source_xor'),
      ('operator_earnings', 'operator_earnings_reversed_bounded')
    ) AS required(tbl, constraint_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = required.tbl
        AND c.conname = required.constraint_name AND c.convalidated)
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('payments_tenantId_idempotencyKey_key'), ('client_wallets_qrToken_key')) AS required(idx)
    WHERE NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = x.relnamespace
      WHERE n.nspname = 'public' AND x.relname = required.idx AND i.indisunique AND i.indisvalid)
  )
  AND EXISTS (SELECT 1 FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL);
SQL
)" || fail "no se pudo validar el esquema o las migraciones"
[ "$schema_ok" = t ] || fail "faltan columnas, restricciones, índices únicos o migraciones completas"

# 2) Migraciones: ninguna del repositorio anterior a la última restaurada falta
#    (una base a medias entre dos versiones). Las posteriores no: la copia
#    puede ser de antes de este commit.
if [ -d "$MIGRATIONS_DIR" ]; then
  values=""
  for dir in "$MIGRATIONS_DIR"/*/; do
    name="$(basename "$dir")"
    [[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || continue
    values="${values:+$values,}('$name')"
  done
  if [ -n "$values" ]; then
    missing="$(run_psql -qtA <<SQL
-- restore-migrations
SELECT COALESCE(string_agg(repo.name, ', ' ORDER BY repo.name), '')
  FROM (VALUES $values) AS repo(name)
 WHERE repo.name <= (SELECT max(migration_name) FROM public._prisma_migrations
                      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM public._prisma_migrations m
                    WHERE m.migration_name = repo.name AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL);
SQL
)" || fail "no se pudieron comparar las migraciones con las del repositorio"
    [ -z "$missing" ] || fail "faltan migraciones anteriores a la última restaurada: $missing"
  fi
fi

# 3) Coherencia mínima del dinero, con el bypass de RLS (que no esconda filas):
#    lo que la app nunca deja pasar y una copia corrupta o a medias sí.
incoherent="$(run_psql -qtA <<'SQL'
-- restore-coherence
SET app.bypass_rls = 'on';
SELECT concat_ws('; ',
  CASE WHEN EXISTS (SELECT 1 FROM client_wallets WHERE "balanceCents" < 0)
       THEN 'saldos negativos' END,
  CASE WHEN EXISTS (SELECT 1 FROM payments WHERE "availableAmountCents" < 0 OR "availableAmountCents" > "amountCents" + "tipCents")
       THEN 'cobros con más por devolver que lo cobrado' END,
  CASE WHEN EXISTS (SELECT 1 FROM refunds r JOIN payments p ON p.id = r."paymentId"
                     WHERE r.status = 'SUCCEEDED'
                     GROUP BY p.id, p."amountCents", p."tipCents"
                    HAVING SUM(r."amountCents") > p."amountCents" + p."tipCents")
       THEN 'devoluciones hechas que superan su cobro' END,
  CASE WHEN EXISTS (SELECT 1 FROM refunds r WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = r."paymentId"))
       THEN 'devoluciones sin su cobro' END
);
SQL
)" || fail "no se pudo comprobar la coherencia de saldos y cobros"
[ -z "$incoherent" ] || fail "la copia no es coherente: $incoherent"

# 4) Datos: como superusuario/dueño y con el bypass de RLS puesto.
counts="$(run_psql -qtA -F ' ' <<'SQL'
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
echo "[restore-check] OK: la copia se restaura entera, es coherente y tiene datos"
