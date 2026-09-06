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

:: ===== Open as a standalone app window (Edge/Chrome --app mode), not a browser tab =====
:: --app gives a dedicated window: no tab bar, no address bar, its own taskbar icon.
:: Quote the full exe path - "Program Files (x86)" contains spaces and parentheses, and
:: cmd only treats parentheses as block syntax outside quotes, so quoting keeps it safe.
:: Give the node server ~1s to boot first. ping works without stdin, so it is reliable
:: in both Normal and Silent (hidden console) modes - unlike timeout /t.
ping -n 2 127.0.0.1 >nul

set "APPURL=http://localhost:%PORT%"
set "BROWSER_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER_EXE%" set "BROWSER_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER_EXE%" set "BROWSER_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER_EXE%" set "BROWSER_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if exist "%BROWSER_EXE%" (
    start "" "%BROWSER_EXE%" --app=%APPURL% --window-size=1400,900
) else (
    rem Fallback: default browser opens a normal tab (legacy behavior)
    start "" %APPURL%
)

:: ===== Run the server in the foreground: logs print into this CMD window =====
node server.js

pause
