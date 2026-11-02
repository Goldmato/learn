@echo off
setlocal
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0breeze-tts.ps1" %*
exit /b %ERRORLEVEL%
