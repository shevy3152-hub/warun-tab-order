@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SERVER_DIR=%~dp0"
set "REPO_DIR=%SERVER_DIR%.."
pushd "%REPO_DIR%" >nul || exit /b 1

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  popd
  exit /b 1
)

if not exist "prototype\node_modules\vite\bin\vite.js" (
  echo Installing prototype dependencies...
  if exist "prototype\pnpm-lock.yaml" (
    where corepack >nul 2>nul
    if not errorlevel 1 (
      pushd prototype
      call corepack pnpm install --frozen-lockfile
      set "INSTALL_RESULT=!ERRORLEVEL!"
      popd
    ) else (
      call npm.cmd --prefix prototype install --no-package-lock --no-audit --no-fund
      set "INSTALL_RESULT=!ERRORLEVEL!"
    )
  ) else (
    call npm.cmd --prefix prototype install --no-package-lock --no-audit --no-fund
    set "INSTALL_RESULT=!ERRORLEVEL!"
  )
  if not "!INSTALL_RESULT!"=="0" (
    echo Dependency installation failed.
    popd
    exit /b %INSTALL_RESULT%
  )
)

echo Building the web client...
pushd prototype
node node_modules\vite\bin\vite.js build
if errorlevel 1 (
  echo Vite build failed.
  popd
  popd
  exit /b 1
)
node scripts\prepare-sites-build.mjs
if errorlevel 1 (
  echo Sites preparation failed.
  popd
  popd
  exit /b 1
)
node scripts\inline-client.mjs
if errorlevel 1 (
  echo Client packaging failed.
  popd
  popd
  exit /b 1
)
popd

set "WARUN_ENV=production"
set "WARUN_AUTO_PROVISION_ADMIN=1"
set "WARUN_DB_PATH=%SERVER_DIR%var\warun.sqlite3"
set "WARUN_ADMIN_TOKEN_FILE=%SERVER_DIR%var\admin-token"
set "WARUN_WEB_ROOT=%REPO_DIR%\prototype\dist\client"
if not exist "%WARUN_WEB_ROOT%\index.html" (
  echo Web root not found: %WARUN_WEB_ROOT%
  popd
  exit /b 1
)

echo Starting Warun. Keep this window open during service.
node server\src\run-server.mjs
set "SERVER_RESULT=!ERRORLEVEL!"
popd
exit /b %SERVER_RESULT%
