# NightPay - bootstrap Windows PowerShell
# Uso: cd nightpay; .\scripts\bootstrap.ps1
# ASCII-only para evitar problemas de encoding en Windows PowerShell 5.1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
Set-Location $here

function Say([string]$msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Die([string]$msg)  { Write-Host "XX  $msg" -ForegroundColor Red; exit 1 }

Say "NightPay bootstrap ($here)"

# --- Checks ---
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die "docker no encontrado (instalar Docker Desktop)"
}

# node: busca en PATH y luego en ubicaciones tipicas de nvm-windows / instalador oficial
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:APPDATA\nvm\nodejs\node.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $nodePath = $c
            $nodeDir = Split-Path -Parent $c
            $env:PATH = "$nodeDir;$env:PATH"
            Warn "node encontrado en $c - agregado al PATH de esta sesion"
            break
        }
    }
}
if (-not $nodePath) {
    Die @"
node no encontrado en PATH ni en ubicaciones tipicas.
Cierra esta PowerShell, abre una NUEVA ventana y verifica:
  node -v    (debe imprimir v22.x)
  pnpm -v    (debe imprimir 9.x)
Si node -v falla en la nueva ventana, ejecuta (en esa nueva ventana):
  nvm install 22.23.3; nvm use 22.23.3
Si sigue fallando, instala Node 22 LTS manualmente desde https://nodejs.org
"@
}

$nodeV = (node -v)
if ($nodeV -notmatch '^v20\.') {
    Warn "Node $nodeV - recomendado v20 LTS. 'nvm install 22.23.3; nvm use 22.23.3' en una ventana nueva"
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Warn "pnpm no encontrado - intentando habilitar corepack"
    try {
        corepack enable
        corepack prepare pnpm@9.12.0 --activate
    } catch {
        Die "No se pudo habilitar pnpm. Instalar manual: 'npm install -g pnpm@9.12.0'"
    }
}

# --- .env.local ---
if (-not (Test-Path .env.local)) {
    Say "Creando .env.local desde .env.example"
    Copy-Item .env.example .env.local
    Warn "Edita .env.local antes de produccion"
}

# --- Docker infra ---
Say "Levantando Postgres + Redis"
docker compose up -d postgres redis

Say "Esperando Postgres saludable..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    docker compose exec -T postgres pg_isready -U np 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ready) { Warn "Postgres tardo en estar listo; continuo igualmente" }

# --- Install deps ---
Say "Instalando deps (pnpm install)"
pnpm install

# --- Prisma ---
Say "Generando cliente Prisma"
pnpm --filter '@nightpay/db' generate

Say "Aplicando migraciones (dev)"
pnpm --filter '@nightpay/db' exec prisma migrate dev --name init
if ($LASTEXITCODE -ne 0) {
    Warn "migrate:dev fallo - probablemente ya aplicada"
}

Say "Seed de datos demo"
pnpm --filter '@nightpay/db' seed
if ($LASTEXITCODE -ne 0) {
    Warn "Seed fallo - revisa manualmente"
}

# --- Mocks (opcional) ---
Say "Levantando mocks pasarela (opcional)"
docker compose up -d mock-wipay mock-peanpe
if ($LASTEXITCODE -ne 0) {
    Warn "Mocks no arrancaron - correrlos directo: 'pnpm --filter @nightpay/mock-wipay dev'"
}

Write-Host ""
Write-Host "OK Bootstrap completo." -ForegroundColor Green
Write-Host ""
Write-Host "Siguiente paso:"
Write-Host "  pnpm dev                          # turbo: api + 3 frontends en paralelo"
Write-Host ""
Write-Host "Verificacion:"
Write-Host "  curl http://localhost:4100/v1/health"
Write-Host "  http://localhost:4101  (web-client)"
Write-Host "  http://localhost:4102  (tpv)"
Write-Host "  http://localhost:4103  (admin)"
