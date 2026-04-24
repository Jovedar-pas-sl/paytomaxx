@echo off
REM ═══════════════════════════════════════════════════════════
REM  🚀 ARRANQUE AUTOMÁTICO - Sistema ATM + WhatsApp
REM ═══════════════════════════════════════════════════════════
REM  Inicia:
REM  1. Docker (Evolution API en puerto 8080)
REM  2. Servidor ATM (puerto 8889)
REM ═══════════════════════════════════════════════════════════

setlocal enabledelayedexpansion
chcp 65001 > nul

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║   🔧 SOPORTE TÉCNICO ATM + WHATSAPP                           ║
echo ║   Iniciando servicios...                                      ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.

REM 1. Verificar si Docker está corriendo
echo ⏳ Verificando Docker...
docker ps > nul 2>&1
IF ERRORLEVEL 1 (
    echo 🐳 Iniciando Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    timeout /t 20 /nobreak
) ELSE (
    echo ✅ Docker ya está corriendo
)

REM 2. Iniciar Evolution API (Chatwoot)
echo.
echo 📱 Iniciando Evolution API (puerto 8080)...
cd /d "C:\Users\mehdi\Documents\GitHub\chatwoot"
start "Evolution API" cmd /k "docker-compose up"

timeout /t 10 /nobreak

REM 3. Iniciar Servidor ATM
echo.
echo 🔧 Iniciando Servidor ATM (puerto 8889)...
cd /d "C:\Users\mehdi\Documents\GitHub\first_tries\manual_browser"
start "Servidor ATM" cmd /k "set PYTHONIOENCODING=utf-8 && py -3 app.py"

echo.
echo ╔═══════════════════════════════════════════════════════════════╗
echo ║   ✅ SERVICIOS INICIADOS                                      ║
echo ║                                                               ║
echo ║   🌐 Acceder a:                                              ║
echo ║   • http://127.0.0.1:8889/sistema      ← PRINCIPAL          ║
echo ║                                                               ║
echo ║   📊 API endpoints:                                          ║
echo ║   • http://localhost:8080 (Evolution API)                    ║
echo ║   • http://localhost:3000 (Chatwoot)                         ║
echo ║                                                               ║
echo ╚═══════════════════════════════════════════════════════════════╝
echo.
pause
