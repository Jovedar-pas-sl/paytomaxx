#!/usr/bin/env bash
# Unit tests: all PostgreSQL/Docker commands are fakes; no external services.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir "$TEMP/bin"
printf PGDMP > "$TEMP/backup.dump"
cat > "$TEMP/bin/psql" <<'SH'
#!/usr/bin/env bash
sql="$*"
if [[ "$sql" == *pg_tables* ]]; then
  echo "${EXISTING_TABLES:-0}"
else
  sql="$(cat)"
  if [[ "$sql" == *restore-schema* ]]; then
    echo "${SCHEMA_OK:-t}"
  else
    echo '1 1 1 2026-10-21T00:00Z 0 migration_complete'
  fi
fi
SH
cat > "$TEMP/bin/pg_restore" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
echo "$*" >> "$CALLS"
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
check() {
  local name="$1" expected="$2"; shift 2
  : > "$CALLS"
  local code=0
  env "$@" bash "$ROOT/scripts/restore-check.sh" "$TEMP/backup.dump" --url postgres://disposable > "$TEMP/output" 2>&1 || code=$?
  if { [ "$expected" = ok ] && [ "$code" = 0 ]; } || { [ "$expected" = fail ] && [ "$code" != 0 ] && ! grep -q '\[restore-check\] OK' "$TEMP/output"; }; then
    echo "PASS $name"
  else
    echo "FAIL $name (exit $code)"; cat "$TEMP/output"; failed=$((failed + 1))
  fi
}
check 'complete custom restore' ok
check 'pg_restore failure despite populated tables' fail RESTORE_EXIT=1
check 'incomplete schema despite populated tables' fail SCHEMA_OK=f
check 'nonempty target is never restored' fail EXISTING_TABLES=3
if [ -s "$CALLS" ]; then echo 'FAIL nonempty target invoked pg_restore'; failed=$((failed + 1)); fi
: > "$CALLS"
code=0
RESTORE_EXIT=1 bash "$ROOT/scripts/restore-check.sh" "$TEMP/backup.dump" > "$TEMP/output" 2>&1 || code=$?
if [ "$code" != 0 ] && grep -q '^rm -f restore-check-' "$CALLS"; then
  echo 'PASS disposable container cleanup on failure'
else
  echo 'FAIL disposable container cleanup on failure'; failed=$((failed + 1))
fi
exit "$failed"
