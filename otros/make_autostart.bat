@echo off
REM Script para crear shortcut de arranque automático
REM Ejecutar como Administrador una sola vez

setlocal enabledelayedexpansion

set STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set BATCH_FILE=C:\Users\mehdi\Documents\GitHub\first_tries\STARTUP.bat

echo Creando acceso directo en Inicio automático...

REM Crear archivo .VBS para crear el shortcut
(
    echo Set oWS = WScript.CreateObject("WScript.Shell"^)
    echo sLinkFile = "%STARTUP_FOLDER%\ATM Startup.lnk"
    echo Set oLink = oWS.CreateShortCut(sLinkFile^)
    echo oLink.TargetPath = "%BATCH_FILE%"
    echo oLink.WorkingDirectory = "C:\Users\mehdi\Documents\GitHub\first_tries"
    echo oLink.Description = "Inicia servicios ATM + WhatsApp"
    echo oLink.Save
    echo WScript.Echo "✅ Shortcut creado en: " ^& sLinkFile
) > "%TEMP%\CreateShortcut.vbs"

cscript.exe "%TEMP%\CreateShortcut.vbs"
del "%TEMP%\CreateShortcut.vbs"

echo.
echo ✅ Listo! El servicio se iniciará automáticamente al abrir sesión.
pause
