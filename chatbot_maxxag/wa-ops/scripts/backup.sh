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

# ── 1. pg_dump kpi DB (Chatwoot/Evolution removed; only kpi remains) ──
log "Dumping kpi DB..."
docker compose exec -T postgres pg_dump \
    -U postgres \
    --format=custom \
    --no-owner \
    --no-acl \
    kpi > "$BACKUP_DIR/kpi.dump"
log "kpi.dump size: $(du -h "$BACKUP_DIR/kpi.dump" | cut -f1)"

# ── 2. Export waha_data volume (WhatsApp sessions — CRITICAL) ────
# If we lose this, all linked WhatsApp numbers must be re-paired by QR scan.
log "Tarring waha_data volume (WhatsApp sessions)..."
docker run --rm \
    -v maxxag-wa-ops_waha_data:/src:ro \
    -v "$BACKUP_DIR":/dst \
    alpine tar czf /dst/waha_data.tar.gz -C /src .
log "waha_data.tar.gz size: $(du -h "$BACKUP_DIR/waha_data.tar.gz" | cut -f1)"

# ── 3. Export archive_data volume (raw event JSONL — secondary record) ──
if docker volume inspect maxxag-wa-ops_archive_data &>/dev/null; then
    log "Tarring archive_data volume (event JSONL)..."
    docker run --rm \
        -v maxxag-wa-ops_archive_data:/src:ro \
        -v "$BACKUP_DIR":/dst \
        alpine tar czf /dst/archive_data.tar.gz -C /src . 2>/dev/null || \
        log "archive_data not present — skipping (was added in event-archive feature)"
fi

# ── 4. Snapshot of .env (encrypted by restic anyway, but useful) ─
if [[ -f "$ROOT/.env" ]]; then
    cp "$ROOT/.env" "$BACKUP_DIR/.env.snapshot"
    log "Captured .env snapshot"
fi

# ── 5. Push to restic repo (encrypted, deduplicated) ────────────
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

# ── 6. Cleanup local dump ───────────────────────────────────────
log "Cleaning up local dump..."
rm -rf "$BACKUP_DIR"

log "Backup complete."
