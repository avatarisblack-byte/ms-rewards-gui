@echo off
title Stop Microsoft Rewards GUI Server
chcp 65001 >nul
cd /d "%~dp0"

echo ================================================
echo   正在停止 Microsoft Rewards GUI 服务...
echo ================================================

:: 停止端口配置：用 node 读取（与 start-gui.bat 保持一致，无 PowerShell），默认 3000
for /f "usebackq delims=" %%p in (`node -e "try{var s=require('./gui-settings.json');console.log(typeof s.port=='number'? s.port:'')}catch(e){}"`) do set "PORT_TO_KILL=%%p"
if "%PORT_TO_KILL%"=="" set PORT_TO_KILL=3000

:: 按端口精准清理：查找监听 PORT_TO_KILL 的 PID 并强制结束
:: 不用 taskkill /im node.exe（会误杀其他 Node 进程，如你的其他脚本）
for /f "tokens=5" %%i in ('netstat -ano ^| findstr ":%PORT_TO_KILL%" ^| findstr "LISTENING"') do (
    echo [GUI] 结束进程 PID %%i （端口 %PORT_TO_KILL%）
    taskkill /f /pid %%i >nul 2>&1
)
:: 兜底：服务可能启动于默认端口而配置文件后来被修改（改端口后未重启即停止），
:: 此时配置文件端口上无进程、旧服务仍在默认端口监听——再尝试清理默认端口 3000，
:: 避免旧服务残留占用端口导致"改端口重启后依然占用旧端口"
if not "%PORT_TO_KILL%"=="3000" (
    for /f "tokens=5" %%i in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
        echo [GUI] 结束进程 PID %%i （端口 3000 兜底）
        taskkill /f /pid %%i >nul 2>&1
    )
)

echo.
echo [完成] 已尝试停止端口 %PORT_TO_KILL% 上的服务。
echo       若上方无 "结束进程" 输出，说明服务本就没在运行。
echo       其他 Node 进程不受影响。
pause