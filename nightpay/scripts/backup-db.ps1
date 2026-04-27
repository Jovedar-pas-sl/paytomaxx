# NightPay - backup diario de Postgres a archivo .sql.gz
# Uso: .\scripts\backup-db.ps1 [-Retention 30]
#
# Programacion sugerida (Windows Task Scheduler):
#   Daily at 06:30 -> powershell.exe -File C:\...\nightpay\scripts\backup-db.ps1
#
# RPO efectivo en dev: 24h. Para prod usar pgBackRest o Wasabi/S3 + WAL streaming.

param(
    [int]$Retention = 30,
    [string]$BackupDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups')
)

$ErrorActionPreference = 'Stop'

function Say([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Die([string]$msg) { Write-Host "XX  $msg" -ForegroundColor Red; exit 1 }

# Verifica Docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die "docker no encontrado"
}

$container = 'nightpay_postgres'
$running = docker ps --filter "name=^$container$" --format '{{.Names}}' 2>$null
if (-not $running) {
    Die "Container $container no esta corriendo. docker compose up -d postgres"
}

# Crear dir
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
}

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$dumpFile = Join-Path $BackupDir "nightpay_$timestamp.sql"
$gzFile = "$dumpFile.gz"

Say "Dump a $dumpFile"
docker exec -i $container pg_dump -U np -d nightpay --no-owner --no-acl --clean --if-exists | Out-File -FilePath $dumpFile -Encoding utf8

if (-not (Test-Path $dumpFile) -or (Get-Item $dumpFile).Length -eq 0) {
    Die "Backup vacio o fallido"
}

Say "Comprimiendo a $gzFile"
# Windows nativo no tiene gzip. Usamos Compress-Archive (zip) o, si tienes 7z:
if (Get-Command 7z -ErrorAction SilentlyContinue) {
    7z a -tgzip "$gzFile" "$dumpFile" | Out-Null
    Remove-Item $dumpFile
    $finalFile = $gzFile
} else {
    $zipFile = "$dumpFile.zip"
    Compress-Archive -Path $dumpFile -DestinationPath $zipFile -Force
    Remove-Item $dumpFile
    $finalFile = $zipFile
    Warn "7z no encontrado; backup en .zip en lugar de .gz"
}

$size = (Get-Item $finalFile).Length / 1KB
Say "OK Backup: $finalFile ($([math]::Round($size,1)) KB)"

# Retencion: borrar backups mas viejos que $Retention dias
Say "Aplicando retencion ($Retention dias)"
$cutoff = (Get-Date).AddDays(-$Retention)
$deleted = 0
Get-ChildItem $BackupDir -File | Where-Object { $_.LastWriteTime -lt $cutoff -and $_.Name -like 'nightpay_*' } | ForEach-Object {
    Remove-Item $_.FullName
    $deleted++
}
if ($deleted -gt 0) {
    Say "Borrados $deleted backups antiguos"
}

Say "Listado actual:"
Get-ChildItem $BackupDir -File | Where-Object { $_.Name -like 'nightpay_*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 10 | Format-Table Name, @{n='Size(KB)';e={[math]::Round($_.Length/1KB,1)}}, LastWriteTime
