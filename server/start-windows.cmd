@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%SCRIPT_DIR%start-windows.ps1"
endlocal
