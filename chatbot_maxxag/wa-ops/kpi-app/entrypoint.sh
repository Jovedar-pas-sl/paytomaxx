#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# KPI app entrypoint — runs alembic migrations then starts the role:
#   web     → uvicorn
#   worker  → arq
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

ROLE="${ROLE:-web}"

if [[ "$ROLE" == "web" ]]; then
    echo "[entrypoint] Running alembic migrations..."
    alembic upgrade head

    echo "[entrypoint] Starting uvicorn..."
    exec python -m uvicorn app.main:app \
        --host 0.0.0.0 \
        --port 5000 \
        --proxy-headers \
        --forwarded-allow-ips '*' \
        --workers 2
elif [[ "$ROLE" == "worker" ]]; then
    echo "[entrypoint] Starting arq worker..."
    exec python -m arq app.analyzer.worker.WorkerSettings
else
    echo "[entrypoint] Unknown ROLE=$ROLE" >&2
    exit 1
fi
