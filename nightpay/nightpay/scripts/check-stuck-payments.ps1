# NightPay - chequeo de pagos atascados
# Uso: .\scripts\check-stuck-payments.ps1 [-MinutesThreshold 30] [-TelegramBotToken xxx -TelegramChatId yyy]
#
# Programacion: cada 10 min via Task Scheduler. Si encuentra pagos en
# AUTHORIZING > N min, escupe la lista (y opcionalmente alerta por Telegram).
# Ver runbook docs/runbooks/P0-pagos-atascados.md.

param(
    [int]$MinutesThreshold = 30,
    [string]$TelegramBotToken,
    [string]$TelegramChatId
)

$ErrorActionPreference = 'Stop'

function Say([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

$container = 'nightpay_postgres'
$query = @"
SELECT id, "tenantId", status, "amountCents",
       EXTRACT(EPOCH FROM (NOW() - "updatedAt"))::int AS stuck_seconds,
       provider, "providerTxId"
  FROM payments
 WHERE status IN ('AUTHORIZING', 'AWAITING_CAPTURE')
   AND "updatedAt" < NOW() - INTERVAL '$MinutesThreshold minutes'
 ORDER BY "updatedAt"
 LIMIT 50;
"@

Say "Buscando pagos en AUTHORIZING/AWAITING_CAPTURE > $MinutesThreshold min..."
$result = docker exec -i $container psql -U np -d nightpay -At -F '|' -c $query 2>$null

if (-not $result -or $result.Trim() -eq '') {
    Say "OK 0 pagos atascados"
    exit 0
}

$lines = $result -split "`n" | Where-Object { $_.Trim() -ne '' }
$count = $lines.Count
Warn "$count pago(s) atascado(s):"

$summary = @()
foreach ($line in $lines) {
    $parts = $line -split '\|'
    if ($parts.Length -lt 6) { continue }
    $id = $parts[0]
    $tenant = $parts[1]
    $status = $parts[2]
    $amount = [int]$parts[3]
    $stuckSec = [int]$parts[4]
    $stuckMin = [math]::Round($stuckSec / 60, 0)
    $providerTx = $parts[6]

    $line2 = "  - $id [$status] amount=$($amount/100)EUR stuck=${stuckMin}min providerTx=$providerTx"
    Write-Host $line2 -ForegroundColor Yellow
    $summary += $line2
}

# Telegram opcional
if ($TelegramBotToken -and $TelegramChatId) {
    $message = "[NightPay] $count pago(s) atascado(s) > $MinutesThreshold min`n" + ($summary -join "`n")
    $url = "https://api.telegram.org/bot$TelegramBotToken/sendMessage"
    try {
        Invoke-RestMethod -Method Post -Uri $url -ContentType 'application/json' -Body (@{
            chat_id = $TelegramChatId
            text = $message
            disable_web_page_preview = $true
        } | ConvertTo-Json) | Out-Null
        Say "Alerta Telegram enviada"
    } catch {
        Warn "No se pudo enviar Telegram: $_"
    }
}

# Exit 1 para que Task Scheduler lo trate como fallo si hay atascados
exit 1
