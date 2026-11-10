@echo off
setlocal
cd /d "%~dp0"
set "BOOT_NODE="
if defined TCG_NODE_EXE (
  if not exist "%TCG_NODE_EXE%" (
    echo TCG_NODE_EXE points to a missing file. Correct it or unset it.
    pause
    exit /b 1
  )
  set "BOOT_NODE=%TCG_NODE_EXE%"
)
if not defined BOOT_NODE if exist "%~dp0.local\runtime\node-v24.22.2-win-x64\node.exe" set "BOOT_NODE=%~dp0.local\runtime\node-v24.22.2-win-x64\node.exe"
if not defined BOOT_NODE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined BOOT_NODE set "BOOT_NODE=%%I"
if not defined BOOT_NODE for /d %%D in ("%USERPROFILE%\.cache\codex-runtimes\*") do if not defined BOOT_NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "BOOT_NODE=%%~fD\dependencies\node\bin\node.exe"
if defined BOOT_NODE (
  "%BOOT_NODE%" "%~dp0scripts\windows-start.mjs" --probe-runtime
  if not errorlevel 1 goto launch
  if defined TCG_NODE_EXE (
    echo TCG_NODE_EXE is not a supported Node/npm runtime. Correct it or unset it.
    pause
    exit /b 1
  )
  set "BOOT_NODE="
)
for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-windows.ps1"`) do set "BOOT_NODE=%%I"
if not defined BOOT_NODE for /f "usebackq delims=" %%I in (`pwsh.exe -NoProfile -File "%~dp0scripts\bootstrap-windows.ps1"`) do set "BOOT_NODE=%%I"
if not defined BOOT_NODE (
  echo TCG Live could not prepare its private runtime. Review the bootstrap message above.
  pause
  exit /b 1
)
set "TCG_NODE_EXE=%BOOT_NODE%"
:launch
"%BOOT_NODE%" "%~dp0scripts\windows-start.mjs" %*
set "TCG_EXIT_CODE=%ERRORLEVEL%"
if not "%TCG_EXIT_CODE%"=="0" (
  echo.
  echo TCG Live did not start. Review the message above.
  pause
)
exit /b %TCG_EXIT_CODE%
