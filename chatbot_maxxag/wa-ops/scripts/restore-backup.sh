#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# Restore from restic backup — interactive, confirms before destroying.
#
# Matches the CURRENT stack written by backup.sh: kpi DB (kpi.dump) +
# waha_data volume (WhatsApp sessions) + optional archive_data volume.
# (The old Chatwoot/Evolution restore path was removed — those services
# no longer exist.)
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

BACKUP_SOURCE=$(find "$RESTORE_DIR" -maxdepth 3 -name "kpi.dump" | head -1)
if [[ -z "$BACKUP_SOURCE" ]]; then
    echo "ERROR: kpi.dump not found under $RESTORE_DIR" >&2
    exit 1
fi
BACKUP_DIR="$(dirname "$BACKUP_SOURCE")"

log "Found backup in $BACKUP_DIR:"
ls -lh "$BACKUP_DIR"
echo
read -r -p "Type 'yes' to proceed (current data will be REPLACED): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
    echo "Aborted."
    exit 0
fi

# Stop everything that reads the DB / WhatsApp volume; keep postgres up so we
# can drop/recreate the kpi DB, and redis (harmless).
log "Stopping app + waha services (postgres/redis stay up)..."
docker compose stop kpi-app kpi-worker caddy waha

# ── Restore kpi DB ────────────────────────────────────────────────
log "Restoring kpi DB..."
docker compose exec -T postgres dropdb --if-exists -U postgres kpi
docker compose exec -T postgres createdb -U postgres kpi
docker compose exec -T postgres pg_restore \
    -U postgres \
    --no-owner \
    --no-acl \
    -d kpi < "$BACKUP_DIR/kpi.dump"

# ── Restore waha_data volume (WhatsApp sessions — avoids re-pairing by QR) ──
if [[ -f "$BACKUP_DIR/waha_data.tar.gz" ]]; then
    log "Restoring waha_data volume (WhatsApp sessions)..."
    docker run --rm \
        -v maxxag-wa-ops_waha_data:/dst \
        -v "$BACKUP_DIR":/src:ro \
        alpine sh -c "rm -rf /dst/* && tar xzf /src/waha_data.tar.gz -C /dst"
fi

# ── Restore archive_data volume (raw event JSONL — secondary record) ──
if [[ -f "$BACKUP_DIR/archive_data.tar.gz" ]]; then
    log "Restoring archive_data volume..."
    docker run --rm \
        -v maxxag-wa-ops_archive_data:/dst \
        -v "$BACKUP_DIR":/src:ro \
        alpine sh -c "rm -rf /dst/* && tar xzf /src/archive_data.tar.gz -C /dst"
fi

log "Starting services..."
docker compose up -d

log "Restore complete. Check 'docker compose logs -f' for errors."
