@echo off
title MoonPay CLI Setup
echo ========================================
echo  MoonPay CLI Setup
echo ========================================
echo.

REM Step 1: Login
echo [Step 1] Sending verification code to alexandrerue@proton.me...
echo.
mp login --email alexandrerue@proton.me
echo.

REM Check login success
mp wallet list >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Login may have failed. Please check the output above.
    echo If you see an error, try running: mp login --email alexandrerue@proton.me
    echo.
    pause
    exit /b 1
)

echo Login successful!
echo.

REM Step 2: Create wallet
echo [Step 2] Creating wallet "main"...
echo NOTE: A BIP39 mnemonic (seed phrase) will be shown. Write it down and keep it safe!
echo.
mp wallet create --name main
echo.

REM Step 3: Show wallet info
echo [Step 3] Wallet details:
echo.
mp wallet list
echo.

echo ========================================
echo  Setup complete!
echo  Copy the EVM address (0x...) above
echo  and add it to your .env file as:
echo  WALLET_ADDRESS=0x...
echo ========================================
echo.
pause
