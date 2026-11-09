@echo off
setlocal
cd /d "%~dp0"
if exist "release\LocalSpace.exe" (
  start "" "%~dp0release\LocalSpace.exe"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12+ is required. Please install Node.js first.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  if not exist "node_modules\typescript\bin\tsc" (
    call npm ci
    if errorlevel 1 exit /b 1
  )
  call npm run build
  if errorlevel 1 exit /b 1
)
node scripts/start.mjs
if errorlevel 1 pause
endlocal
