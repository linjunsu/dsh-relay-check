@echo off
setlocal
title DeepSeek Relay Check

rem NOTE: keep this file pure ASCII. cmd.exe parses .bat bytes in the console
rem OEM codepage, so non-ASCII comments or messages corrupt the parse.

rem %~dp0 is this file's own folder (with trailing backslash), so the project
rem can be moved or renamed without editing anything here.
set "PROJ=%~dp0"
if "%PORT%"=="" set "PORT=8787"
set "URL=http://127.0.0.1:%PORT%/"

rem ping, not timeout: timeout.exe aborts with "Input redirection is not
rem supported" whenever stdin is redirected, and a PATH carrying GNU coreutils
rem (Git Bash, msys) shadows it outright. ping sleeps ~1s and never complains.
set "SLEEP1=ping -n 2 127.0.0.1"

if not exist "%PROJ%bin\serve.mjs" (
  echo [ERROR] bin\serve.mjs not found next to this file.
  echo         Keep this .bat inside the deepseek-relay-check folder.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node is not on PATH. Install Node.js 20 or newer.
  pause
  exit /b 1
)

rem Port probe via netstat rather than PowerShell: netstat answers in ~45ms
rem while launching powershell.exe costs ~1.3s. Two findstr passes avoid
rem quoting a pattern that contains a space.
netstat -ano -p tcp | findstr LISTENING | findstr :%PORT% >nul
if not errorlevel 1 (
  echo Already running - opening %URL%
  start %URL%
  %SLEEP1% >nul
  exit /b 0
)

rem Poll in a minimized window and open the browser only once the port answers,
rem so the page never loads before the server is ready. 90s cap.
start "wait" /min cmd /c "for /l %%i in (1,1,90) do (netstat -ano -p tcp | findstr LISTENING | findstr :%PORT% >nul && (start %URL% & exit) || %SLEEP1% >nul)"

echo Starting on %URL%
echo Close this window or press Ctrl+C to stop.
echo.
cd /d "%PROJ%"
node "%PROJ%bin\serve.mjs"

rem Only reached if the server exits or crashes - keep the error on screen.
echo.
echo [server stopped]
pause
