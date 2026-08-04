#!/usr/bin/env bash
#
# Offsite, encrypted backup of the WAHA sessions volume (creds.json + pre-keys)
# to Backblaze B2 via restic. A dead/rebuilt server can restore these and skip
# re-pairing all the WhatsApp numbers.
#
# The docker volume already survives `build` / `up --force-recreate`; this guards
# the cases it does NOT survive: disk failure, `docker compose down -v`, or the
# whole VPS being lost. restic encrypts everything client-side (RESTIC_PASSWORD),
# so B2 only ever stores opaque blobs.
#
# ── One-time setup (on the VPS) ──────────────────────────────────────────
#   apt-get update && apt-get install -y restic
#   nano /opt/wa-ops/.restic.env        # paste the 4 exports below, real values
#   chmod 600 /opt/wa-ops/.restic.env
#   source /opt/wa-ops/.restic.env && restic init      # once, creates the repo
#   chmod +x /opt/wa-ops/scripts/backup_waha.sh
#   /opt/wa-ops/scripts/backup_waha.sh                 # test run
#   # daily at 04:00:
#   ( crontab -l 2>/dev/null; echo "0 4 * * * /opt/wa-ops/scripts/backup_waha.sh >> /var/log/waha_backup.log 2>&1" ) | crontab -
#
# /opt/wa-ops/.restic.env  (root-only, NEVER in git):
#   export B2_ACCOUNT_ID=<b2 keyID>
#   export B2_ACCOUNT_KEY=<b2 applicationKey>
#   export RESTIC_REPOSITORY=b2:<your-bucket-name>:waha
#   export RESTIC_PASSWORD=<a strong passphrase>   # ⚠ KEEP THIS — lose it = backups unrecoverable
#
# ── Restore (after a disaster, on a fresh VPS with the stack deployed) ────
#   source /opt/wa-ops/.restic.env
#   restic snapshots                                   # list backups
#   restic restore latest --target /tmp/waha_restore
#   docker compose -f /opt/wa-ops/docker-compose.yml stop waha
#   cp -a /tmp/waha_restore/var/lib/docker/volumes/maxxag-wa-ops_waha_data/_data/. \
#         /var/lib/docker/volumes/maxxag-wa-ops_waha_data/_data/
#   docker compose -f /opt/wa-ops/docker-compose.yml start waha
#
set -euo pipefail

ENV_FILE="/opt/wa-ops/.restic.env"
VOL_PATH="/var/lib/docker/volumes/maxxag-wa-ops_waha_data/_data"

if [ ! -f "$ENV_FILE" ]; then
  echo "[backup_waha] missing $ENV_FILE — see setup notes in this script" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

if [ ! -d "$VOL_PATH" ]; then
  echo "[backup_waha] volume not found at $VOL_PATH — is the stack up?" >&2
  exit 1
fi

# Back up the sessions dir, then trim old snapshots. restic dedups so daily runs
# on tiny, mostly-unchanged creds cost almost nothing.
restic backup "$VOL_PATH" --tag waha --host maxxag-vps
restic forget --tag waha --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune

echo "[backup_waha] done $(date -u +%FT%TZ)"
