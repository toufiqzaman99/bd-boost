@echo off
cd /d "%~dp0"
echo Starting Thunder Maxit server...
start "Thunder Maxit Server" cmd /k "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/admin"
