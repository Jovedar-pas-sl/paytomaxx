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

# CRITICAL: ALWAYS scrub the local backup dir on exit (success or failure).
# Without this, .env.snapshot + the unencrypted dump survive on disk if
# restic is unconfigured, the script errors out, or someone CTRL+Cs it.
cleanup() {
    if [[ -d "$BACKUP_DIR" ]]; then
        rm -rf "$BACKUP_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

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

# ── 4. Push to restic repo (encrypted, deduplicated) ────────────
# IMPORTANT: only snapshot .env AFTER we know we'll ship it encrypted.
# Otherwise the trap-cleanup deletes it, but we never write a plaintext
# secret to disk for longer than the restic upload.
if command -v restic &>/dev/null && [[ -n "${RESTIC_REPOSITORY:-}" ]]; then
    if [[ -f "$ROOT/.env" ]]; then
        cp "$ROOT/.env" "$BACKUP_DIR/.env.snapshot"
        log "Captured .env snapshot (will be encrypted by restic)"
    fi
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
    # No restic → do NOT snapshot .env (would leak in plaintext).
    log "WARN: restic not configured — backup stays local AND will be cleaned"
    log "      on exit (see trap). Set up restic with:"
    log "  export RESTIC_REPOSITORY='b2:your-bucket:/maxxag'"
    log "  export RESTIC_PASSWORD='<strong-passphrase>'"
    log "  export B2_ACCOUNT_ID='...' B2_ACCOUNT_KEY='...'"
    log "  restic init"
fi

# Cleanup is handled by `trap cleanup EXIT` — runs even on errors / Ctrl+C.
log "Backup complete."