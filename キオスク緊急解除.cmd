@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Warun kiosk emergency exit. This script preserves app data, pairing, and orders.
rem Normal path uses the existing DEBUG_NORMAL_EXIT_ACTION in MainActivity.
rem The force path is never automatic and is offered only after normal exit fails.
set "PACKAGE=jp.co.warun.androidkiosk"
set "COMPONENT=jp.co.warun.androidkiosk/.MainActivity"
set "NORMAL_EXIT_ACTION=jp.co.warun.androidkiosk.action.DEBUG_NORMAL_EXIT"
set "SCRIPT_DIR=%~dp0"
set "ADB="
set "SERIAL="
set "DEVICE_COUNT=0"

call :find_adb
if not defined ADB (
  echo.
  echo adb.exeが見つかりません。
  echo Android SDK Platform Toolsをインストールし、PATHに追加するか、
  echo %%LOCALAPPDATA%%\Android\Sdk\platform-tools\adb.exe に配置してください。
  set "RESULT_CODE=2"
  goto :finish
)

echo Warunキオスク緊急解除
echo ADB: %ADB%
echo.
call :refresh_devices
if "%DEVICE_COUNT%"=="0" goto :wireless_connect
if "%DEVICE_COUNT%"=="1" (
  echo !DESC_1! | findstr /i /c:"model:A90" /c:"device:A90" >nul
  if errorlevel 1 (
    echo online端末は見つかりましたが、A90として確認できません。
    goto :wireless_connect
  )
  set "SERIAL=!SERIAL_1!"
  echo 接続先を自動選択しました: !SERIAL!
) else (
  echo 複数のonline端末が見つかりました。対象端末を番号で選択してください。
  call :choose_device
  if errorlevel 1 (
    set "RESULT_CODE=3"
    goto :finish
  )
)
goto :run_normal

:wireless_connect
echo onlineの端末が見つかりません。
set "WIRELESS_TARGET="
set /p "WIRELESS_TARGET=ワイヤレスデバッグのIP:portを入力（USB接続なら空Enter）："
if not defined WIRELESS_TARGET (
  echo USB接続またはワイヤレスデバッグ接続を確認してから再実行してください。
  set "RESULT_CODE=4"
  goto :finish
)
echo adb connectを実行します: %WIRELESS_TARGET%
"%ADB%" connect "%WIRELESS_TARGET%"
if errorlevel 1 (
  echo 接続に失敗しました。IP:portとワイヤレスデバッグ状態を確認してください。
  set "RESULT_CODE=5"
  goto :finish
)
call :refresh_devices
if "%DEVICE_COUNT%"=="0" (
  echo 接続後もonline端末を確認できませんでした。
  set "RESULT_CODE=6"
  goto :finish
)
if "%DEVICE_COUNT%"=="1" (
  echo !DESC_1! | findstr /i /c:"model:A90" /c:"device:A90" >nul
  if errorlevel 1 (
    echo 接続先がA90として確認できませんでした。
    set "RESULT_CODE=7"
    goto :finish
  )
  set "SERIAL=!SERIAL_1!"
) else (
  call :choose_device
  if errorlevel 1 (
    set "RESULT_CODE=3"
    goto :finish
  )
)

:run_normal
echo.
echo 対象serial: %SERIAL%
echo 既存の正常終了ACTIONを明示componentへ送信します。
"%ADB%" -s "%SERIAL%" shell am start -W -n "%COMPONENT%" -a "%NORMAL_EXIT_ACTION%"
if errorlevel 1 goto :normal_failed
call :wait_for_not_kiosk
if errorlevel 1 goto :normal_failed
"%ADB%" -s "%SERIAL%" shell am start -a android.intent.action.MAIN -c android.intent.category.HOME >nul 2>&1
if errorlevel 1 goto :normal_failed
call :wait_for_not_kiosk
if errorlevel 1 goto :normal_failed

echo.
echo 正常解除に成功しました。
echo 対象serial: %SERIAL%
echo Android HOMEへ復帰しました。pairing、アプリデータ、注文データは保持されています。
set "RESULT_CODE=0"
goto :finish

:normal_failed
echo.
echo 正常終了ACTIONでHOME復帰を確認できませんでした。
echo 1: 再試行
echo 2: 強制解除（Lock Task解除が利用可能なら実行後、force-stop）
echo 3: 中止
choice /c 123 /n /m "選択してください: "
if errorlevel 3 (
  echo 中止しました。アプリ、pairing、データは変更していません。
  set "RESULT_CODE=10"
  goto :finish
)
if errorlevel 2 goto :force_release
if errorlevel 1 goto :run_normal

:force_release
echo.
echo 明示選択により強制解除を実行します。
echo Lock Task解除を試行し、続いてpackageのforce-stop、Android HOME復帰を行います。
"%ADB%" -s "%SERIAL%" shell am task lock stop >nul 2>&1
"%ADB%" -s "%SERIAL%" shell am force-stop "%PACKAGE%"
if errorlevel 1 (
  echo force-stopに失敗しました。
  set "RESULT_CODE=11"
  goto :finish
)
"%ADB%" -s "%SERIAL%" shell am start -a android.intent.action.MAIN -c android.intent.category.HOME >nul 2>&1
call :wait_for_not_kiosk
if errorlevel 1 (
  echo 強制解除後のHOME復帰を確認できませんでした。
  set "RESULT_CODE=12"
  goto :finish
)
echo.
echo 強制解除が完了しました。対象serial: %SERIAL%
echo pairing、アプリデータ、注文データは削除していません。
echo 次回起動時にWebView renderer復旧のためA90再起動が必要になる可能性があります。
set "RESULT_CODE=0"
goto :finish

:finish
call :pause_result %RESULT_CODE%
exit /b %RESULT_CODE%

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
if not "%DEVICE_COUNT%"=="0" (
  for /l %%N in (1,1,%DEVICE_COUNT%) do echo [%%N] !SERIAL_%%N! !DESC_%%N!
)
exit /b 0

:choose_device
set "CHOICE="
set /p "CHOICE=対象serialの番号を入力: "
for /f "delims=0123456789" %%A in ("%CHOICE%") do set "CHOICE="
if not defined CHOICE (
  echo 番号が不正です。
  exit /b 1
)
if %CHOICE% LSS 1 exit /b 1
if %CHOICE% GTR %DEVICE_COUNT% exit /b 1
for %%N in (%CHOICE%) do set "SERIAL=!SERIAL_%%N!"
if not defined SERIAL exit /b 1
echo 選択したserial: %SERIAL%
exit /b 0

:wait_for_not_kiosk
set "CHECK_FILE=%TEMP%\warun-kiosk-exit-%RANDOM%.txt"
set "TOP_FILE=%CHECK_FILE%.top"
for /l %%N in (1,1,10) do (
  "%ADB%" -s "%SERIAL%" shell dumpsys activity activities > "%CHECK_FILE%" 2>nul
  findstr /i /c:"mResumedActivity" /c:"topResumedActivity" /c:"mFocusedApp" "%CHECK_FILE%" > "%TOP_FILE%" 2>nul
  set "TOP="
  for /f "delims=" %%A in (%TOP_FILE%) do set "TOP=%%A"
  if defined TOP (
    findstr /i /c:"%PACKAGE%" "%TOP_FILE%" >nul
    if errorlevel 1 (
      del /q "%CHECK_FILE%" "%TOP_FILE%" >nul 2>&1
      exit /b 0
    )
  )
  >nul timeout /t 1 /nobreak
)
del /q "%CHECK_FILE%" "%TOP_FILE%" >nul 2>&1
exit /b 1

:pause_result
set "RESULT_CODE=%~1"
echo.
pause
exit /b %RESULT_CODE%
