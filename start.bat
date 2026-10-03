@echo off
title ERP License Manager
echo.
echo ╔══════════════════════════════════════════════╗
echo ║       ERP License Manager - Starting...      ║
echo ╚══════════════════════════════════════════════╝
echo.

:: Use local Node.js if available
if exist "%~dp0..\node-bin\node.exe" (
    set "PATH=%~dp0..\node-bin;%PATH%"
)

:: Install dependencies if needed
if not exist "%~dp0node_modules" (
    echo Installing dependencies...
    cd /d "%~dp0"
    npm install
    echo.
)

:: Start the server
cd /d "%~dp0"
node server.js
pause
