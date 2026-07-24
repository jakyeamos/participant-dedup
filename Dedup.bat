@echo off
REM Double-click this on Windows (or run: Dedup.bat)
cd /d "%~dp0"

set "DEDUP_BIN=dist-bin\dedup.exe"
if not exist "%DEDUP_BIN%" (
  if exist "dedup.exe" (
    set "DEDUP_BIN=dedup.exe"
  ) else (
    echo Cannot find dist-bin\dedup.exe or dedup.exe
    echo Ask your teammate to run: pnpm dedup:compile
    pause
    exit /b 1
  )
)

echo.
echo   Participant Dedup
echo   -----------------
echo   1^) Scan   - find duplicates
echo   2^) Review - choose what to keep
echo   3^) Apply  - delete marked rows (asks to confirm^)
echo   4^) Quit
echo.
set /p choice="Pick 1-4: "

if "%choice%"=="1" "%DEDUP_BIN%" scan
if "%choice%"=="2" "%DEDUP_BIN%" review
if "%choice%"=="3" "%DEDUP_BIN%" apply
if "%choice%"=="4" goto end
if not "%choice%"=="1" if not "%choice%"=="2" if not "%choice%"=="3" echo Bye.

:end
echo.
pause
