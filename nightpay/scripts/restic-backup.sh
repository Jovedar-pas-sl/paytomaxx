#!/bin/sh
# restic-backup — copia de la base cifrada con restic (Backblaze B2 u otro
# repositorio), independiente de Dokploy. La lanza el cron del contenedor
# "oxiopay-restic" (docs/BACKUPS.md, apartado 7); también se puede lanzar a mano:
#   docker exec oxiopay-restic /copia.sh
#
# Variables (las pone --env-file): PGHOST PGUSER PGPASSWORD PGDATABASE
# RESTIC_REPOSITORY RESTIC_PASSWORD B2_ACCOUNT_ID B2_ACCOUNT_KEY y, opcional,
# TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID para avisar si falla.
set -eu
set -o pipefail

aviso() {
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -o /dev/null "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode chat_id="$TELEGRAM_CHAT_ID" --data-urlencode text="$1" || true
  fi
}

ahora() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# pg_dump en formato propio (-Fc), directo a restic: no toca el disco. Con
# --stdin-from-command (restic >= 0.17), si pg_dump falla a medias restic NO
# guarda la instantánea: una copia truncada nunca queda como «latest».
if restic backup --quiet --stdin-from-command --stdin-filename nightpay.dump --tag nightpay -- pg_dump -Fc; then
  # 7 días de copias de cada 6 h, 8 semanas y 12 meses.
  restic forget --quiet --tag nightpay --keep-within-hourly 7d --keep-weekly 8 --keep-monthly 12 --prune \
    || aviso "⚠️ OxioPay: la copia restic se hizo, pero falló la limpieza de copias antiguas"
  echo "copia OK $(ahora)"
else
  echo "copia FALLIDA $(ahora)" >&2
  aviso "⚠️ OxioPay: falló la copia restic de la base de datos ($(ahora))"
  exit 1
fi
