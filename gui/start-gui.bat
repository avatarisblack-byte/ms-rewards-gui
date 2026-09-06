@echo off
title Microsoft Rewards Script Console
cd /d "%~dp0"

:: ===== Normal Mode: keep this CMD window for server logs, no PowerShell windows =====
:: Browser is opened with the native CMD "start" command below (no PowerShell spawn).

:: ===== Read GUI port from gui-settings.json (set in GUI Settings page), default 3000 =====
:: Use node instead of PowerShell: node is required by this project anyway and starts
:: in ~200ms vs ~1s for PowerShell. The JS keeps to chars safe inside for /f backticks
:: (no | & < >), and prints an empty string when the file is missing/invalid so the
:: fallback below applies.
for /f "usebackq delims=" %%p in (`node -e "try{var s=require('./gui-settings.json');console.log(typeof s.port=='number'? s.port:'')}catch(e){}"`) do set "PORT=%%p"
if "%PORT%"=="" set PORT=3000

if not exist "server.js" (
    echo [ERROR] server.js not found. Current directory: %cd%
    pause
    exit /b 1
)

echo ================================================
echo   Starting Microsoft Rewards Script Console...
echo   Port: http://localhost:%PORT%
echo ================================================
echo.

:: ===== Open the browser with the native CMD start command (no PowerShell window) =====
:: Give the node server ~1s to boot first. ping works without stdin, so it is reliable
:: in both Normal and Silent (hidden console) modes - unlike timeout /t.
ping -n 2 127.0.0.1 >nul
start "" http://localhost:%PORT%

:: ===== Run the server in the foreground: logs print into this CMD window =====
node server.js

pause
