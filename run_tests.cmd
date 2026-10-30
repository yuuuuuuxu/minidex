@echo off
REM One-click setup for Windows: install dependencies, compile, run tests.
REM Full output is saved to run_log.txt in this folder.
cd /d "%~dp0"
set LOG=run_log.txt
echo MiniDEX - setup and test > %LOG%
echo. >> %LOG%

echo [1/4] Checking Node.js ...
echo ===== node -v ===== >> %LOG%
node -v >> %LOG% 2>&1
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org and try again.
  echo NODE NOT FOUND >> %LOG%
  pause
  exit /b 1
)

echo [2/4] Installing dependencies (npm install, 1-3 minutes) ...
echo. >> %LOG%
echo ===== npm install ===== >> %LOG%
call npm install >> %LOG% 2>&1

echo [3/4] Compiling contracts ...
echo. >> %LOG%
echo ===== hardhat compile ===== >> %LOG%
call npx hardhat compile >> %LOG% 2>&1

echo [4/4] Running tests ...
echo. >> %LOG%
echo ===== hardhat test ===== >> %LOG%
call npx hardhat test >> %LOG% 2>&1

echo.
echo ================= TEST RESULTS =================
type %LOG% | findstr /R /C:"passing" /C:"failing" /C:"pending" /C:"Error" /C:"Compiled"
echo ================================================
echo Full log saved to run_log.txt
pause
