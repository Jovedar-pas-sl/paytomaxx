# Deploy script — merge windows + delete conversation + period filter fix
# Usage:  .\scripts\deploy-merge-fixes.ps1
# Run from:  chatbot_maxxag\wa-ops\  (the directory containing kpi-app\)

$ErrorActionPreference = "Stop"

$VPS = if ($env:VPS) { $env:VPS } else { "root@72.62.190.116" }
$REMOTE_PATH = if ($env:REMOTE_PATH) { $env:REMOTE_PATH } else { "/opt/wa-ops" }

Write-Host "=== Deploy to $VPS`:$REMOTE_PATH ===" -ForegroundColor Cyan

# 1. Upload Python code
Write-Host "[1/4] Uploading Python files..." -ForegroundColor Yellow
scp kpi-app/app/settings.py              "$VPS`:$REMOTE_PATH/kpi-app/app/"
scp kpi-app/app/queries.py               "$VPS`:$REMOTE_PATH/kpi-app/app/"
scp kpi-app/app/routes/conversation.py   "$VPS`:$REMOTE_PATH/kpi-app/app/routes/"
scp kpi-app/app/routes/casa_workspace.py "$VPS`:$REMOTE_PATH/kpi-app/app/routes/"
scp kpi-app/app/routes/webhooks.py       "$VPS`:$REMOTE_PATH/kpi-app/app/routes/"

# 2. Upload templates
Write-Host "[2/4] Uploading templates..." -ForegroundColor Yellow
scp kpi-app/app/templates/conversation.html         "$VPS`:$REMOTE_PATH/kpi-app/app/templates/"
scp kpi-app/app/templates/tabs/metricas.html        "$VPS`:$REMOTE_PATH/kpi-app/app/templates/tabs/"

# 3. Rebuild + recreate
Write-Host "[3/4] Building image and restarting services..." -ForegroundColor Yellow
ssh $VPS "cd $REMOTE_PATH && docker compose build kpi-app && docker compose up -d --force-recreate kpi-app kpi-worker"

# 4. Verify
Write-Host "[4/4] Verifying health..." -ForegroundColor Yellow
Start-Sleep -Seconds 5
ssh $VPS "cd $REMOTE_PATH && docker compose ps"

Write-Host ""
Write-Host "=== Deploy complete ===" -ForegroundColor Green
Write-Host "Test:  https://your-domain/casas/<id>?tab=chats&period=3d"
