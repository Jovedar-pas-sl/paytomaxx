# Deploy script — wa-ops archive layer + infinite scroll + UX fixes
# Usage: .\scripts\deploy-archive-fixes.ps1
# Run from: chatbot_maxxag\wa-ops\
# Te pedira password SSH del VPS UNA VEZ (subida) + UNA VEZ (rebuild).

$ErrorActionPreference = "Stop"

$VPS = "root@72.62.190.116"
$REMOTE = "/opt/wa-ops"

Write-Host "=== Deploy archive layer + UX fixes ===" -ForegroundColor Cyan

# 1. Sube el tarball (relativo a la carpeta wa-ops/)
$Tarball = Join-Path $PSScriptRoot "..\wa-ops-deploy.tgz" | Resolve-Path
Write-Host "[1/3] Subiendo tarball ($([math]::Round((Get-Item $Tarball).Length / 1KB)) KB)..." -ForegroundColor Yellow
scp $Tarball "${VPS}:/tmp/wa-ops-deploy.tgz"
if ($LASTEXITCODE -ne 0) { throw "SCP fallo" }

# 2. Extrae sobre /opt/wa-ops + rebuild + restart
Write-Host "[2/3] Extrayendo y rebuilding..." -ForegroundColor Yellow
ssh $VPS "set -e; cd $REMOTE && tar -xzf /tmp/wa-ops-deploy.tgz && rm /tmp/wa-ops-deploy.tgz && docker compose build kpi-app && docker compose up -d --force-recreate kpi-app kpi-worker"
if ($LASTEXITCODE -ne 0) { throw "Build/restart fallo" }

# 3. Verifica
Write-Host "[3/3] Verificando..." -ForegroundColor Yellow
Start-Sleep -Seconds 5
ssh $VPS "cd $REMOTE && docker compose ps --format 'table {{.Service}}\t{{.Status}}'"

Write-Host ""
Write-Host "=== Deploy completo ===" -ForegroundColor Green
Write-Host "Verifica:" -ForegroundColor Cyan
Write-Host "  - Pagina casa: scroll abajo deberia cargar mas conversaciones"
Write-Host "  - JSONL en VPS: ssh $VPS 'ls -la /var/lib/docker/volumes/maxxag-wa-ops_archive_data/_data/'"
Write-Host "  - Stats: curl https://kpi.masajesmaxx.com/api/archive/stats (necesita login)"
