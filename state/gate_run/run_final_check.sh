#!/usr/bin/env bash
set -e
export PATH=/c/Users/yhxu4/AppData/Local/nvm/v20.20.0:/c/Users/yhxu4/AppData/Roaming/npm:/usr/bin:$PATH
BASE=/d/TradingBots/claude/moonpay/bnb-trading-agent
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
RPC=http://127.0.0.1:8545
VAULT=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
SETTLER=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
ORACLE=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
NFA=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
REGISTRY=0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9
KEYSTORE="$BASE/state/gate_run/keystores/final_signer.json"

mkdir -p "$BASE/state/gate_run/keystores"

# Create keystore
cast wallet import "$KEYSTORE" --private-key $PK --unsafe-password "testpassword" 2>&1 || true

cd "$BASE"

echo ""
echo "=== 1. preflight (keystore mode) ==="
ARENA_SETTLEMENT_MODE=onchain \
ARENA_CHAIN_RPC_URL=$RPC \
ARENA_SETTLER_CONTRACT=$SETTLER \
LEARNING_ROOT_ORACLE=$ORACLE \
ARENA_SIGNER_KEYSTORE=$KEYSTORE \
node cli/dist/index.js arena preflight 2>&1

echo ""
echo "=== 2. bootstrap-onchain run 1 ==="
ARENA_SETTLEMENT_MODE=onchain \
ARENA_CHAIN_RPC_URL=$RPC \
ARENA_SETTLER_CONTRACT=$SETTLER \
LEARNING_ROOT_ORACLE=$ORACLE \
ARENA_SIGNER_PRIVATE_KEY=$PK \
ARENA_ALLOW_INSECURE_PRIVATE_KEY=1 \
ARENA_ENABLE_AGENT_ONCHAIN_REGISTRATION=1 \
AGENT_NFA_CONTRACT=$NFA \
AGENT_ACCOUNT_REGISTRY=$REGISTRY \
ARENA_AGENT_NFA_MINT_TO=$OWNER \
ARENA_AGENT_TOKEN_URI_PREFIX=ipfs://arena-agent \
ARENA_AGENT_TBA_SALT=0 \
ARENA_AGENT_REGISTRATION_LOG_PATH=state/gate_run/final_agent_reg.jsonl \
node cli/dist/index.js arena bootstrap-onchain 2>&1

echo ""
echo "=== 3. bootstrap-onchain run 2 (idempotency) ==="
ARENA_SETTLEMENT_MODE=onchain \
ARENA_CHAIN_RPC_URL=$RPC \
ARENA_SETTLER_CONTRACT=$SETTLER \
LEARNING_ROOT_ORACLE=$ORACLE \
ARENA_SIGNER_PRIVATE_KEY=$PK \
ARENA_ALLOW_INSECURE_PRIVATE_KEY=1 \
ARENA_ENABLE_AGENT_ONCHAIN_REGISTRATION=1 \
AGENT_NFA_CONTRACT=$NFA \
AGENT_ACCOUNT_REGISTRY=$REGISTRY \
ARENA_AGENT_NFA_MINT_TO=$OWNER \
ARENA_AGENT_TOKEN_URI_PREFIX=ipfs://arena-agent \
ARENA_AGENT_TBA_SALT=0 \
ARENA_AGENT_REGISTRATION_LOG_PATH=state/gate_run/final_agent_reg.jsonl \
node cli/dist/index.js arena bootstrap-onchain 2>&1
