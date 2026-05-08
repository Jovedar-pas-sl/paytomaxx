# Unified deploy script — replaces the 14+ deploy-*.ps1 helpers.
#
# What it does (in order):
#   1. Builds a tarball from the file list you specify (or from `git diff` since
#      the last deploy commit if you don't list files)
#   2. SCPs to the VPS, extracts into /opt/wa-ops
#   3. Optionally runs `alembic upgrade head` (auto-detect: triggers if any
#      file in alembic/versions/ was included)
#   4. Builds + recreates the affected services (auto-detect: kpi-app for
#      app/templates, kpi-worker for app/analyzer)
#
# Usage examples:
#   # Deploy everything that changed since HEAD~1
#   .\scripts\deploy.ps1
#
#   # Deploy specific files
#   .\scripts\deploy.ps1 -Files "kpi-app/app/templates/tabs/chats.html","kpi-app/app/queries.py"
#
#   # Deploy + force migration
#   .\scripts\deploy.ps1 -Migration
#
#   # Deploy + force rebuild of both services
#   .\scripts\deploy.ps1 -RebuildAll
#
#   # Skip migration even if a file under alembic/ changed
#   .\scripts\deploy.ps1 -NoMigration
#
#   # Only worker (when you only changed analyzer code)
#   .\scripts\deploy.ps1 -Services worker

[CmdletBinding()]
param(
    [string[]]$Files = @(),
    [switch]$Migration,
    [switch]$NoMigration,
    [switch]$RebuildAll,
    [ValidateSet("auto", "app", "worker", "both")]
    [string]$Services = "auto",
    [string]$VPS = "root@72.62.190.116",
    [string]$Remote = "/opt/wa-ops",
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Warn([string]$msg) {
    Write-Host "!! $msg" -ForegroundColor Yellow
}

# ── 1. Decide which files to ship ──────────────────────────────
if ($Files.Count -eq 0) {
    Write-Step "No -Files given; auto-detecting from git diff HEAD~1..HEAD"
    Push-Location $ProjectRoot
    try {
        $diffOut = & git diff --name-only HEAD~1 HEAD -- chatbot_maxxag/wa-ops/ 2>&1
        if ($LASTEXITCODE -ne 0) { throw "git diff failed: $diffOut" }
        # Strip the chatbot_maxxag/wa-ops/ prefix because the tarball is built
        # relative to the wa-ops dir.
        $Files = $diffOut |
            Where-Object { $_ -like "chatbot_maxxag/wa-ops/*" } |
            ForEach-Object { $_ -replace '^chatbot_maxxag/wa-ops/', '' }
    } finally {
        Pop-Location
    }
    if ($Files.Count -eq 0) {
        throw "No wa-ops files changed in HEAD~1..HEAD. Pass -Files explicitly."
    }
}

Write-Step "Files to deploy ($($Files.Count)):"
$Files | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

# Sanity check: every file must exist locally
foreach ($f in $Files) {
    $full = Join-Path $ProjectRoot "chatbot_maxxag\wa-ops\$f"
    if (-not (Test-Path $full)) {
        throw "File not found: $full"
    }
}

# ── 2. Auto-detect needed actions from file list ───────────────
$hasMigration = $false
$hasAppFiles = $false
$hasWorkerFiles = $false
foreach ($f in $Files) {
    if ($f -like "kpi-app/alembic/versions/*") { $hasMigration = $true }
    if ($f -like "kpi-app/app/templates/*" -or $f -like "kpi-app/app/routes/*" -or
        $f -like "kpi-app/app/main.py" -or $f -like "kpi-app/app/deps.py" -or
        $f -like "kpi-app/app/queries.py" -or $f -like "kpi-app/app/settings.py" -or
        $f -like "kpi-app/app/template_env.py" -or $f -like "kpi-app/app/logging_config.py") {
        $hasAppFiles = $true
    }
    if ($f -like "kpi-app/app/analyzer/*") { $hasWorkerFiles = $true }
}

# Both services share the kpi-app image base; safer to rebuild both whenever
# any python file changes.
$rebuildApp = $hasAppFiles -or $hasWorkerFiles -or $RebuildAll
$rebuildWorker = $hasWorkerFiles -or $hasAppFiles -or $RebuildAll

if ($Services -eq "app") { $rebuildWorker = $false }
elseif ($Services -eq "worker") { $rebuildApp = $false }
elseif ($Services -eq "both") { $rebuildApp = $true; $rebuildWorker = $true }

$runMigration = ($hasMigration -or $Migration) -and -not $NoMigration

Write-Step "Plan:"
Write-Host "    migration: $runMigration"  -ForegroundColor DarkGray
Write-Host "    rebuild kpi-app: $rebuildApp"  -ForegroundColor DarkGray
Write-Host "    rebuild kpi-worker: $rebuildWorker"  -ForegroundColor DarkGray

# ── 3. Build tarball ──────────────────────────────────────────
$waOpsRoot = Join-Path $ProjectRoot "chatbot_maxxag\wa-ops"
$Tarball = Join-Path $waOpsRoot "wa-ops-deploy.tgz"
Push-Location $waOpsRoot
try {
    Write-Step "Building tarball..."
    # POSIX tar: pass file list, paths relative to current dir
    $tarArgs = @("-czf", $Tarball)
    $tarArgs += $Files
    & tar @tarArgs
    if ($LASTEXITCODE -ne 0) { throw "tar failed" }
    $size = (Get-Item $Tarball).Length
    Write-Host "    $([math]::Round($size / 1KB)) KB" -ForegroundColor DarkGray
} finally {
    Pop-Location
}

# ── 4. Upload + extract + deploy ──────────────────────────────
Write-Step "Uploading to $VPS..."
& scp $Tarball "${VPS}:/tmp/wa-ops-deploy.tgz"
if ($LASTEXITCODE -ne 0) { throw "SCP failed" }

# Build the remote bash script as a single here-string so we send 1 ssh
$remoteScript = @"
set -e
cd $Remote
tar -xzf /tmp/wa-ops-deploy.tgz
rm /tmp/wa-ops-deploy.tgz
chmod +x scripts/*.sh 2>/dev/null || true
"@

if ($runMigration) {
    $remoteScript += "`necho '--- Running alembic upgrade head ---'`n"
    $remoteScript += "docker compose exec -T kpi-app alembic upgrade head || echo 'Alembic returned non-zero (might already be applied)'`n"
}

if ($rebuildApp -and $rebuildWorker) {
    $remoteScript += "`necho '--- Building kpi-app + kpi-worker ---'`n"
    $remoteScript += "docker compose build kpi-app kpi-worker`n"
    $remoteScript += "docker compose up -d --force-recreate kpi-app kpi-worker`n"
} elseif ($rebuildApp) {
    $remoteScript += "`necho '--- Building kpi-app only ---'`n"
    $remoteScript += "docker compose build kpi-app`n"
    $remoteScript += "docker compose up -d --force-recreate kpi-app`n"
} elseif ($rebuildWorker) {
    $remoteScript += "`necho '--- Building kpi-worker only ---'`n"
    $remoteScript += "docker compose build kpi-worker`n"
    $remoteScript += "docker compose up -d --force-recreate kpi-worker`n"
} else {
    Write-Warn "No service rebuild scheduled. Use -RebuildAll if needed."
}

# Cleanup stale Redis progress flags (cheap, idempotent)
$remoteScript += "`ndocker compose exec -T redis redis-cli -n 2 KEYS 'progress:*' | xargs -r docker compose exec -T redis redis-cli -n 2 DEL >/dev/null 2>&1 || true`n"

Write-Step "Running on remote..."
& ssh $VPS $remoteScript
if ($LASTEXITCODE -ne 0) { throw "Remote deploy failed" }

Start-Sleep -Seconds 4
Write-Step "Status:"
& ssh $VPS "cd $Remote && docker compose ps --format 'table {{.Service}}\t{{.Status}}'"

# ── 5. Cleanup local tarball ──────────────────────────────────
Remove-Item -Force $Tarball -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Deploy complete." -ForegroundColor Green
