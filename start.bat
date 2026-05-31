@echo off
setlocal enabledelayedexpansion
title bot-platform
cd /d "%~dp0"

REM ====================================================================
REM  one-time setup
REM ====================================================================

cls
echo.
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo     [error]  node.js not installed
  echo              install Node 22 LTS or newer from https://nodejs.org
  echo.
  pause >nul
  exit /b 1
)

REM Run npm install on every start so newly-added deps (e.g. otplib) get
REM pulled in automatically after a code update. It's a no-op when nothing
REM has changed (~3-5s) and avoids the "missing package, bot crash-loops"
REM trap we hit on 2026-05-16 with otplib.
echo     checking dependencies...
call npm install --silent >nul 2>&1
if errorlevel 1 (
  echo     [error]  npm install failed
  echo.
  pause >nul
  exit /b 1
)

where pm2 >nul 2>&1
if errorlevel 1 (
  echo     installing pm2...
  call npm install -g pm2 --silent >nul 2>&1
  if errorlevel 1 (
    echo     [error]  pm2 install failed ^(try an elevated terminal^)
    echo.
    pause >nul
    exit /b 1
  )
)

set "MISSING_ENV="
for %%b in (code-bot payment-bot card-bot) do (
  if not exist "bots\%%b\.env" set "MISSING_ENV=!MISSING_ENV! %%b"
)
if defined MISSING_ENV (
  echo     [error]  missing .env:!MISSING_ENV!
  echo              copy bots\^<bot^>\.env.example to bots\^<bot^>\.env first
  echo.
  pause >nul
  exit /b 1
)

call pm2 startOrReload pm2.config.cjs --update-env >nul 2>&1
call pm2 save >nul 2>&1

REM ====================================================================
REM  control panel REPL
REM ====================================================================

set "MSG="

:loop
cls
echo.
echo.

node scripts\status.js "!MSG!"
set "MSG="

set "CMD="
set /p "CMD=     > "
if not defined CMD goto loop

set "VERB="
set "ARG="
for /f "tokens=1,2*" %%a in ("!CMD!") do (
  set "VERB=%%a"
  set "ARG=%%b"
)
if not defined VERB goto loop

if /i "!VERB!"=="q" goto end
if /i "!VERB!"=="quit" goto end
if /i "!VERB!"=="exit" goto end

if /i "!VERB!"=="start" (
  call pm2 start pm2.config.cjs >nul 2>&1
  call pm2 save >nul 2>&1
  set "MSG=started"
  goto loop
)

if /i "!VERB!"=="stop" (
  call pm2 stop pm2.config.cjs >nul 2>&1
  call pm2 save >nul 2>&1
  set "MSG=stopped"
  goto loop
)

if /i "!VERB!"=="restart" (
  if defined ARG (
    call pm2 restart !ARG! >nul 2>&1
    set "MSG=restarted !ARG!"
  ) else (
    call pm2 restart pm2.config.cjs >nul 2>&1
    set "MSG=restarted all"
  )
  goto loop
)

if /i "!VERB!"=="status" goto loop

if /i "!VERB!"=="cleanup" (
  call "%~dp0cleanup.bat" /quiet >nul 2>&1
  set "MSG=cleaned up logs and cache"
  goto loop
)

set "MSG=unknown command: !VERB!"
goto loop

:end
endlocal
