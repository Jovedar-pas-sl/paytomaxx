#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# Restore from restic backup — interactive, confirms before destroying.
#
# Usage: bash scripts/restore-backup.sh [snapshot_id | latest]
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

SNAPSHOT="${1:-latest}"
RESTORE_DIR="/tmp/maxxag-restore-$(date +%s)"

log() { echo "[$(date -Is)] $*"; }

if [[ -z "${RESTIC_REPOSITORY:-}" ]]; then
    echo "ERROR: RESTIC_REPOSITORY not set in environment." >&2
    exit 1
fi

log "Restoring snapshot $SNAPSHOT to $RESTORE_DIR..."
mkdir -p "$RESTORE_DIR"
restic restore "$SNAPSHOT" --target "$RESTORE_DIR"

BACKUP_SOURCE=$(find "$RESTORE_DIR" -maxdepth 3 -name "chatwoot_production.dump" | head -1)
if [[ -z "$BACKUP_SOURCE" ]]; then
    echo "ERROR: backup dumps not found under $RESTORE_DIR" >&2
    exit 1
fi
BACKUP_DIR="$(dirname "$BACKUP_SOURCE")"

log "Found dumps in $BACKUP_DIR"
log "This will RESTORE:"
ls -lh "$BACKUP_DIR"
echo
read -r -p "Type 'yes' to proceed (current data will be REPLACED): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
    echo "Aborted."
    exit 0
fi

# Stop all services except postgres
log "Stopping services..."
docker compose stop chatwoot-rails chatwoot-sidekiq evolution kpi-app kpi-worker caddy

# Restore each DB
for DB in chatwoot_production evolution kpi; do
    log "Restoring $DB..."
    docker compose exec -T postgres dropdb --if-exists -U postgres "$DB"
    docker compose exec -T postgres createdb -U postgres "$DB"
    docker compose exec -T postgres pg_restore \
        -U postgres \
        --no-owner \
        --no-acl \
        -d "$DB" < "$BACKUP_DIR/${DB}.dump"
done

# Restore evolution_instances volume
if [[ -f "$BACKUP_DIR/evolution_instances.tar.gz" ]]; then
    log "Restoring evolution_instances volume..."
    docker run --rm \
        -v maxxag-wa-ops_evolution_instances:/dst \
        -v "$BACKUP_DIR":/src:ro \
        alpine sh -c "rm -rf /dst/* && tar xzf /src/evolution_instances.tar.gz -C /dst"
fi

log "Starting services..."
docker compose up -d

log "Restore complete. Check 'docker compose logs -f' for errors."
