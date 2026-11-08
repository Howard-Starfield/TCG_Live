@echo off
setlocal
cd /d "%~dp0"
set "BOOT_NODE="
if defined TCG_NODE_EXE if exist "%TCG_NODE_EXE%" set "BOOT_NODE=%TCG_NODE_EXE%"
if not defined BOOT_NODE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined BOOT_NODE set "BOOT_NODE=%%I"
if not defined BOOT_NODE for /d %%D in ("%USERPROFILE%\.cache\codex-runtimes\*") do if not defined BOOT_NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "BOOT_NODE=%%~fD\dependencies\node\bin\node.exe"
if not defined BOOT_NODE (
  echo Node.js was not found. Install Node.js 24.15.0 or newer within 24.x.
  pause
  exit /b 1
)
"%BOOT_NODE%" "%~dp0scripts\windows-start.mjs" %*
set "TCG_EXIT_CODE=%ERRORLEVEL%"
if not "%TCG_EXIT_CODE%"=="0" (
  echo.
  echo TCG Live did not start. Review the message above.
  pause
)
exit /b %TCG_EXIT_CODE%
