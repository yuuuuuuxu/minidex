@echo off
REM One-click deployment to the Sepolia testnet. Requires a filled-in .env file.
REM Output is saved to deploy_log.txt (it contains addresses only, never your key).
cd /d "%~dp0"
set LOG=deploy_log.txt

if not exist .env (
  echo .env file not found. Fill in .env first.
  pause
  exit /b 1
)

echo Deploying MiniDEX to Sepolia. This takes 1-3 minutes, please wait ...
echo MiniDEX - Sepolia deployment > %LOG%
call npx hardhat run scripts/deploy.js --network sepolia >> %LOG% 2>&1
type %LOG%
echo.
echo Full log saved to deploy_log.txt
pause
