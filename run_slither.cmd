@echo off
REM One-click Slither static analysis (Windows). Uses Anaconda's Python if present.
cd /d "%~dp0"
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python

echo [1/3] Installing Slither (first time only, 1-2 minutes) ...
"%PY%" -m pip install --quiet --disable-pip-version-check slither-analyzer
if errorlevel 1 (
  echo Could not install slither-analyzer. Copy this window's text and send it to Claude.
  pause
  exit /b 1
)

echo [2/3] Compiling contracts ...
call npx hardhat compile

echo [3/3] Running Slither ...
echo.
if exist slither_report.json del slither_report.json
"%PY%" -m slither . --config-file slither.config.json --json slither_report.json

echo.
echo ==========================================================
echo Done. Take a screenshot of this window for the report.
echo Full results saved to slither_report.json
echo ==========================================================
pause
