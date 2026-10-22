#!/usr/bin/env bash
# Pruebas de restore-check.sh con psql, pg_restore y docker de mentira: ni
# Postgres ni Docker de verdad (la restauración real la hace CI, job
# integracion, con una copia completa y otra incompleta).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir "$TEMP/bin"
printf PGDMP > "$TEMP/backup.dump"
printf -- '-- plain-dump\nCREATE TABLE x ();\n' > "$TEMP/backup.sql"
# psql de mentira: contesta según la consulta (marcada con un comentario).
cat > "$TEMP/bin/psql" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *pg_tables* ]]; then
  echo "${EXISTING_TABLES:-0}"
  exit 0
fi
sql="$(cat)"
case "$sql" in
  *plain-dump*) exit "${PSQL_RESTORE_EXIT:-0}" ;;
  *restore-schema*) echo "${SCHEMA_OK:-t}" ;;
  *restore-migrations*) echo "${MISSING_MIGRATIONS:-}" ;;
  *restore-coherence*) echo "${INCOHERENT:-}" ;;
  *) echo '1 1 1 2026-10-21T00:00Z 0 migration_complete' ;;
esac
SH
cat > "$TEMP/bin/pg_restore" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
echo "pg_restore $*" >> "$CALLS"
exit "${RESTORE_EXIT:-0}"
SH
cat > "$TEMP/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
case "$1" in
  run|rm) exit 0 ;;
  exec)
    shift
    [ "${1:-}" != '-i' ] || shift
    shift
    command="$1"; shift
    [ "$command" != pg_isready ] || exit 0
    "$command" "$@"
    ;;
esac
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$TEMP/bin/sleep"
chmod +x "$TEMP/bin/"*
export PATH="$TEMP/bin:$PATH" CALLS="$TEMP/calls"
failed=0
pass() { echo "PASS $1"; }
flunk() { echo "FAIL $1"; cat "$TEMP/output"; failed=$((failed + 1)); }

# check <nombre> ok|fail [texto que debe salir] -- VAR=valor…
check() {
  local name="$1" expected="$2" text="${3:-}"; shift 3
  : > "$CALLS"
  local code=0
  env "$@" bash "$ROOT/scripts/restore-check.sh" "${DUMP_FILE:-$TEMP/backup.dump}" --url postgres://disposable > "$TEMP/output" 2>&1 || code=$?
  if [ "$expected" = ok ]; then
    [ "$code" = 0 ] && grep -q '\[restore-check\] OK' "$TEMP/output" && pass "$name" || flunk "$name (exit $code)"
  else
    if [ "$code" != 0 ] && ! grep -q '\[restore-check\] OK' "$TEMP/output" && { [ -z "$text" ] || grep -qF "$text" "$TEMP/output"; }; then
      pass "$name"
    else
      flunk "$name (exit $code)"
    fi
  fi
}

check 'copia completa (formato propio)' ok '' -- X=1
grep -q -- '--exit-on-error' "$CALLS" && pass 'pg_restore con --exit-on-error' || flunk 'pg_restore con --exit-on-error'
check 'pg_restore falla aunque las tablas tengan filas' fail 'pg_restore falló' -- RESTORE_EXIT=1
check 'esquema incompleto aunque las tablas tengan filas' fail 'faltan columnas, restricciones' -- SCHEMA_OK=f
check 'falta una migración anterior a la última restaurada' fail 'faltan migraciones anteriores a la última restaurada: 20260424082148_init' -- MISSING_MIGRATIONS=20260424082148_init
check 'saldos o cobros incoherentes' fail 'la copia no es coherente: saldos negativos' -- 'INCOHERENT=saldos negativos'
check 'faltan cobros' fail 'payments = 1 (mínimo 2)' -- MIN_PAYMENTS=2
check 'base de destino con tablas: no se restaura encima' fail 'no está vacía' -- EXISTING_TABLES=3
if grep -q '^pg_restore' "$CALLS"; then echo 'FAIL la base con tablas llegó a pg_restore'; failed=$((failed + 1)); fi
DUMP_FILE="$TEMP/backup.sql" check 'SQL plano completo' ok '' -- X=1
DUMP_FILE="$TEMP/backup.sql" check 'SQL plano con un error al restaurar' fail 'psql falló al restaurar' -- PSQL_RESTORE_EXIT=3

# Sin --url: el Postgres de usar y tirar en Docker se borra también si falla.
: > "$CALLS"
code=0
RESTORE_EXIT=1 bash "$ROOT/scripts/restore-check.sh" "$TEMP/backup.dump" > "$TEMP/output" 2>&1 || code=$?
if [ "$code" != 0 ] && grep -q '^rm -f restore-check-' "$CALLS"; then
  pass 'el contenedor de usar y tirar se borra al fallar'
else
  flunk 'el contenedor de usar y tirar se borra al fallar'
fi
exit "$failed"
