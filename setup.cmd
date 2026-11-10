@echo off
setlocal
rem magpie-agent-trae-bridge — one-shot setup for Trae CN / Trae (Windows)
set "HERE=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [magpie-trae-bridge] Node.js 20+ is required but "node" was not found in PATH.
  exit /b 1
)

set "ARGS="
:parse
if "%~1"=="" goto run
if /i "%~1"=="--trae" (
  set "ARGS=%ARGS% --trae "%~2""
  shift & shift & goto parse
)
set "ARGS=%ARGS% %~1"
shift
goto parse

:run
node "%HERE%bin\trae-magpie.js" install%ARGS%
if errorlevel 1 (
  echo [magpie-trae-bridge] install failed.
  exit /b 1
)
echo.
echo [magpie-trae-bridge] done. Restart Trae to load the Magpie model catalog.
endlocal
