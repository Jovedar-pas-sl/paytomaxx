@echo off
cd /d "%~dp0manual_browser"
echo Iniciando servidor ATM en http://172.16.51.242:8889
py -3 -X utf8 app.py
pause
