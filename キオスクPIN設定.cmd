@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ACTION=jp.co.warun.androidkiosk.action.OPEN_PIN_SETUP"
set "PACKAGE=jp.co.warun.androidkiosk"
set "SCRIPT_DIR=%~dp0"
set "ADB="
set "SERIAL="
set "DEVICE_COUNT=0"

call :find_adb
if not defined ADB (
  echo adb.exeが見つかりません。
  echo Android SDK Platform ToolsをPATHに追加するか、
  echo %%LOCALAPPDATA%%\Android\Sdk\platform-tools\adb.exe に配置してください。
  set "RESULT_CODE=2"
  goto :finish
)

echo Warunキオスク PIN設定
call :refresh_devices
if "%DEVICE_COUNT%"=="0" goto :no_devices
if "%DEVICE_COUNT%"=="1" (
  echo !DESC_1! | findstr /i /c:"model:A90" /c:"device:A90" >nul
  if errorlevel 1 (
    echo A90として確認できるonline端末がありません。
    set "RESULT_CODE=3"
    goto :finish
  )
  set "SERIAL=!SERIAL_1!"
) else (
  echo 複数のonline端末があります。対象端末を番号で選択してください。
  call :choose_device
  if errorlevel 1 (
    set "RESULT_CODE=4"
    goto :finish
  )
)
goto :open_setup

:no_devices
echo online端末が見つかりません。USB接続またはWireless ADB接続を確認してください。
set "RESULT_CODE=5"
goto :finish

:open_setup
echo 対象serial: %SERIAL%
"%ADB%" -s "%SERIAL%" shell am start -W -n "%PACKAGE%/.MainActivity" -a "%ACTION%" >nul
if errorlevel 1 (
  echo A90のPIN設定画面を表示できませんでした。
  set "RESULT_CODE=6"
  goto :finish
)
echo A90にPIN設定画面を表示しました。
echo 4桁PINをA90上で2回入力してください。
echo このCMDはPIN保存結果を判定しません。保存結果はA90画面で確認してください。
set "RESULT_CODE=0"
goto :finish

:find_adb
set "SDK_ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if exist "%SDK_ADB%" (
  set "ADB=%SDK_ADB%"
  exit /b 0
)
for /f "delims=" %%A in ('where adb.exe 2^>nul') do if not defined ADB set "ADB=%%A"
exit /b 0

:refresh_devices
set "DEVICE_COUNT=0"
for /l %%N in (1,1,20) do (
  set "SERIAL_%%N="
  set "DESC_%%N="
)
for /f "skip=1 tokens=1,2,*" %%A in ('"%ADB%" devices -l') do (
  if "%%B"=="device" (
    set /a DEVICE_COUNT+=1
    set "SERIAL_!DEVICE_COUNT!=%%A"
    set "DESC_!DEVICE_COUNT!=%%C"
  )
)
if not "%DEVICE_COUNT%"=="0" for /l %%N in (1,1,%DEVICE_COUNT%) do echo [%%N] !SERIAL_%%N! !DESC_%%N!
exit /b 0

:choose_device
set "CHOICE="
set /p "CHOICE=対象serialの番号を入力: "
for /f "delims=0123456789" %%A in ("%CHOICE%") do set "CHOICE="
if not defined CHOICE exit /b 1
if %CHOICE% LSS 1 exit /b 1
if %CHOICE% GTR %DEVICE_COUNT% exit /b 1
for %%N in (%CHOICE%) do set "SERIAL=!SERIAL_%%N!"
if not defined SERIAL exit /b 1
exit /b 0

:finish
echo.
pause
exit /b %RESULT_CODE%