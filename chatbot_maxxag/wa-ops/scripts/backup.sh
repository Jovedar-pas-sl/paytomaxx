#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# Daily backup: pg_dump all 3 DBs + encrypt with restic + ship to B2/S3
#
# Usage:  bash scripts/backup.sh
# Cron:   0 4 * * *  /root/wa-ops/scripts/backup.sh >> /var/log/maxxag-backup.log 2>&1
#
# Requires: RESTIC_REPOSITORY + RESTIC_PASSWORD + B2/S3 credentials in
#           environment (set by cron or /etc/environment).
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
BACKUP_DIR="/tmp/maxxag-backup-$(date +%Y%m%d_%H%M%S)"

cd "$ROOT"
mkdir -p "$BACKUP_DIR"

log() { echo "[$(date -Is)] $*"; }

log "Starting backup..."

# ── 1. pg_dump all DBs ──────────────────────────────────────────
for DB in chatwoot_production evolution kpi; do
    log "Dumping $DB..."
    docker compose exec -T postgres pg_dump \
        -U postgres \
        --format=custom \
        --no-owner \
        --no-acl \
        "$DB" > "$BACKUP_DIR/${DB}.dump"
done

# ── 2. Export evolution_instances volume (WA session data) ──────
log "Tarring evolution_instances volume..."
docker run --rm \
    -v maxxag-wa-ops_evolution_instances:/src:ro \
    -v "$BACKUP_DIR":/dst \
    alpine tar czf /dst/evolution_instances.tar.gz -C /src .

# ── 3. Push to restic repo (encrypted, deduplicated) ────────────
if command -v restic &>/dev/null && [[ -n "${RESTIC_REPOSITORY:-}" ]]; then
    log "Pushing to restic repo $RESTIC_REPOSITORY..."
    restic backup "$BACKUP_DIR" \
        --tag "daily,maxxag-wa-ops" \
        --host "$(hostname)"
    log "Pruning old snapshots (keep 30 daily)..."
    restic forget \
        --keep-daily 30 \
        --keep-weekly 8 \
        --keep-monthly 6 \
        --prune
else
    log "WARN: restic not configured — leaving dump in $BACKUP_DIR"
    log "Set up restic with:"
    log "  export RESTIC_REPOSITORY='b2:your-bucket:/maxxag'"
    log "  export RESTIC_PASSWORD='<strong-passphrase>'"
    log "  export B2_ACCOUNT_ID='...' B2_ACCOUNT_KEY='...'"
    log "  restic init"
    exit 0
fi

# ── 4. Cleanup local dump ───────────────────────────────────────
log "Cleaning up local dump..."
rm -rf "$BACKUP_DIR"

log "Backup complete."
