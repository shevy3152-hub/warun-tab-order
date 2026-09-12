@echo off
setlocal EnableExtensions

set "APP_HOME=%~dp0"
set "APP_ROOT=%APP_HOME:~0,-1%"
set "JBR_ROOT=%ProgramFiles%\Android\Android Studio\jbr"
set "JDK_ROOT="

if exist "%JBR_ROOT%\bin\javaw.exe" set "JDK_ROOT=%JBR_ROOT%"
if not defined JDK_ROOT if exist "%JAVA_HOME%\bin\javaw.exe" set "JDK_ROOT=%JAVA_HOME%"
if not defined JDK_ROOT for /f "delims=" %%I in ('where.exe javaw.exe 2^>nul') do if not defined JDK_ROOT for %%J in ("%%~dpI..") do set "JDK_ROOT=%%~fJ"
if not defined JDK_ROOT goto :nojava

set "JAVAW_EXE=%JDK_ROOT%\bin\javaw.exe"
set "JAR=%APP_ROOT%\android-kiosk\tools\release-builder\build\warun-kiosk-release-builder.jar"
set "READY_MARKER=%TEMP%\warun-kiosk-release-builder-%RANDOM%-%RANDOM%.ready"
if not exist "%JAVAW_EXE%" goto :nojava
if not exist "%JAR%" goto :nojar

pushd "%APP_ROOT%\android-kiosk" >nul 2>&1
start "" /b "%JAVAW_EXE%" -jar "%JAR%" "%APP_ROOT%" "%READY_MARKER%"
popd
exit /b 0

:nojava
mshta.exe "javascript:var sh=new ActiveXObject('WScript.Shell');sh.Popup('\u004a\u0061\u0076\u0061\u307e\u305f\u306f\u540c\u3058\u004a\u0044\u004b\u306e\u5b9f\u884c\u30d5\u30a1\u30a4\u30eb\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002\u004a\u0042\u0052\u307e\u305f\u306f\u004a\u0044\u004b\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002',0,'\u308f\u308b\u3093 \u30ad\u30aa\u30b9\u30af\u672c\u756aAPK\u4f5c\u6210',48);close();"
exit /b 2

:nojar
mshta.exe "javascript:var sh=new ActiveXObject('WScript.Shell');sh.Popup('\u5b9f\u884c\u53ef\u80fdJAR\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002',0,'\u308f\u308b\u3093 \u30ad\u30aa\u30b9\u30af\u672c\u756aAPK\u4f5c\u6210',16);close();"
exit /b 1
