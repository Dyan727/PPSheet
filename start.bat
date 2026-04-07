@echo off
taskkill /F /IM node.exe >nul 2>&1
echo Redirecting you to something greater...
start "" /B node "%~dp0server.js" >nul 2>&1
timeout /t 2 /nobreak >nul
exit
