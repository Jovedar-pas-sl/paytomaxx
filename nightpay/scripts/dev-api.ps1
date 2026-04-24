# NightPay - arranca el API limpio (mata zombis + dev)
# Uso: .\scripts\dev-api.ps1

$here = Split-Path -Parent $PSScriptRoot
Set-Location $here

Write-Host "==> Matando node.exe zombis..." -ForegroundColor Cyan
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$inUse = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
    Write-Host "!!  Puerto 3100 aun ocupado por PID $($inUse.OwningProcess). Matando..." -ForegroundColor Yellow
    Stop-Process -Id $inUse.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

Write-Host "==> pnpm --filter '@nightpay/api' dev" -ForegroundColor Cyan
pnpm --filter "@nightpay/api" dev
