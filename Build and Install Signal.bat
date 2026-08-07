@echo off
setlocal
cd /d "%~dp0"
title RSignals Installer Builder

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js LTS is required to build RSignals.
  echo Install it, then run this file again.
  pause
  exit /b 1
)

if not exist node_modules\electron\package.json (
  echo Preparing the RSignals installer. This happens only once...
  call npm install
  if errorlevel 1 goto :failed
)

echo Building the normal RSignals Windows application...
call npm run dist
if errorlevel 1 goto :failed

for %%F in (dist\RSignals-Setup-*.exe) do (
  echo Starting %%~nxF...
  start "" "%%~fF"
  exit /b 0
)

echo Build completed, but the installer could not be located.
pause
exit /b 1

:failed
echo.
echo RSignals could not be built. Leave this window open and send a screenshot of the error.
pause
exit /b 1
