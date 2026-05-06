#!/bin/bash
# Deploy script — merge windows + delete conversation + period filter fix
# Usage:  bash scripts/deploy-merge-fixes.sh
# Run from:  chatbot_maxxag/wa-ops/  (the directory containing kpi-app/)

set -e

VPS="${VPS:-root@72.62.190.116}"
REMOTE_PATH="${REMOTE_PATH:-/opt/wa-ops}"

echo "=== Deploy to $VPS:$REMOTE_PATH ==="

# 1. Upload Python code
echo "[1/4] Uploading Python files..."
scp kpi-app/app/settings.py             "$VPS:$REMOTE_PATH/kpi-app/app/"
scp kpi-app/app/queries.py              "$VPS:$REMOTE_PATH/kpi-app/app/"
scp kpi-app/app/routes/conversation.py  "$VPS:$REMOTE_PATH/kpi-app/app/routes/"
scp kpi-app/app/routes/casa_workspace.py "$VPS:$REMOTE_PATH/kpi-app/app/routes/"
scp kpi-app/app/routes/webhooks.py      "$VPS:$REMOTE_PATH/kpi-app/app/routes/"

# 2. Upload templates
echo "[2/4] Uploading templates..."
scp kpi-app/app/templates/conversation.html       "$VPS:$REMOTE_PATH/kpi-app/app/templates/"
scp kpi-app/app/templates/tabs/metricas.html      "$VPS:$REMOTE_PATH/kpi-app/app/templates/tabs/"

# 3. Rebuild + recreate (templates + Python both need rebuild)
echo "[3/4] Building image and restarting services..."
ssh "$VPS" "cd $REMOTE_PATH && docker compose build kpi-app && docker compose up -d --force-recreate kpi-app kpi-worker"

# 4. Verify health
echo "[4/4] Verifying health..."
sleep 5
ssh "$VPS" "cd $REMOTE_PATH && docker compose ps --format 'table {{.Service}}\t{{.Status}}' | head -10"

echo ""
echo "=== Deploy complete ==="
echo "Test the changes at https://\$DOMAIN/casas/<id>?tab=chats&period=3d"
