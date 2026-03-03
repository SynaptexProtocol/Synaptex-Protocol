#!/usr/bin/env bash
export PATH=/c/Users/yhxu4/AppData/Local/nvm/v20.20.0:/c/Users/yhxu4/AppData/Roaming/npm:/usr/bin:$PATH
cd /d/TradingBots/claude/moonpay/bnb-trading-agent/contracts
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
OWNER=$OWNER PRIVATE_KEY=$PK forge script script/Deploy.s.sol:Deploy \
  --rpc-url http://127.0.0.1:8545 --broadcast 2>&1
