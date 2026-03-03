#!/usr/bin/env bash
export PATH=/c/Users/yhxu4/AppData/Local/nvm/v20.20.0:/c/Users/yhxu4/AppData/Roaming/npm:/usr/bin:$PATH
cd /d/TradingBots/claude/moonpay/bnb-trading-agent

export ARENA_SETTLEMENT_MODE=onchain
export ARENA_CHAIN_RPC_URL=http://127.0.0.1:8545
export ARENA_SETTLER_CONTRACT=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
export LEARNING_ROOT_ORACLE=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
export ARENA_SIGNER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export ARENA_ALLOW_INSECURE_PRIVATE_KEY=1
unset ARENA_SIGNER_KEYSTORE

echo "=== arena start (45s) ==="
timeout 45 node cli/dist/index.js arena start 2>&1 | head -30 || true

echo ""
echo "=== cycle_commitments check ==="
cat state/arena/cycle_commitments.jsonl

echo ""
echo "=== sync-learning ==="
node cli/dist/index.js arena sync-learning --limit 50 2>&1

echo ""
echo "=== ops-report ==="
node cli/dist/index.js arena ops-report 2>&1
echo "---"
cat state/arena/ops_report.md
