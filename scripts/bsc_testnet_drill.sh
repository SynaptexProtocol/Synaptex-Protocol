#!/usr/bin/env bash
# =============================================================================
# Arena Protocol — BSC Testnet Full-Chain Drill Script
# Usage: bash scripts/bsc_testnet_drill.sh
#
# Required env vars (set in .env.bsc_testnet or export before running):
#   BSC_TESTNET_RPC_URL    e.g. https://bsc-testnet-dataseed.bnbchain.org
#   BSC_TESTNET_PRIVATE_KEY  0x... funded deployer key on BSC Testnet
#   BSC_TESTNET_OWNER        0x... owner address (can equal deployer)
#
# Optional:
#   LOCK_CONFIG              true|false (default: false for drill)
#   DRILL_ARENA_CYCLES       number of cycles to wait for (default: 2)
#
# Get BSC Testnet BNB: https://testnet.bnbchain.org/faucet-smart
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
LOG_DIR="$ROOT_DIR/logs/bsc_testnet_drill"
ARTIFACT_DIR="$ROOT_DIR/state/bsc_testnet_drill"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DRILL_LOG="$LOG_DIR/drill_${TIMESTAMP}.log"

mkdir -p "$LOG_DIR" "$ARTIFACT_DIR"

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
pass() { echo -e "${GREEN}[PASS]${NC} $*" | tee -a "$DRILL_LOG"; }
fail() { echo -e "${RED}[FAIL]${NC} $*" | tee -a "$DRILL_LOG"; exit 1; }
info() { echo -e "${BLUE}[INFO]${NC} $*" | tee -a "$DRILL_LOG"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "$DRILL_LOG"; }

# ── Load env ───────────────────────────────────────────────────────────────────
ENV_FILE="$ROOT_DIR/.env.bsc_testnet"
if [ -f "$ENV_FILE" ]; then
  info "Loading $ENV_FILE"
  set -a; source "$ENV_FILE"; set +a
fi

# Validate required env
: "${BSC_TESTNET_RPC_URL:?BSC_TESTNET_RPC_URL is required}"
: "${BSC_TESTNET_PRIVATE_KEY:?BSC_TESTNET_PRIVATE_KEY is required}"
: "${BSC_TESTNET_OWNER:?BSC_TESTNET_OWNER is required}"

DRILL_ARENA_CYCLES="${DRILL_ARENA_CYCLES:-2}"
LOCK_CONFIG="${LOCK_CONFIG:-false}"

info "========================================================"
info " Arena Protocol — BSC Testnet Drill  ($TIMESTAMP)"
info " RPC   : $BSC_TESTNET_RPC_URL"
info " Owner : $BSC_TESTNET_OWNER"
info " Cycles: $DRILL_ARENA_CYCLES"
info "========================================================"

# ── Step 1: Build contracts ────────────────────────────────────────────────────
info "[Step 1] forge build"
cd "$CONTRACTS_DIR"
forge build 2>&1 | tee -a "$DRILL_LOG"
pass "forge build OK"

# ── Step 2: forge test ────────────────────────────────────────────────────────
info "[Step 2] forge test"
RESULT=$(forge test 2>&1 | tee -a "$DRILL_LOG")
SUMMARY_LINE=$(echo "$RESULT" | grep "tests passed,")
PASSED=$(echo "$SUMMARY_LINE" | grep -o '[0-9]* tests passed' | grep -o '^[0-9]*' || echo "0")
FAILED=$(echo "$SUMMARY_LINE" | grep -o '[0-9]* failed' | grep -o '^[0-9]*' || echo "0")
if [ -z "$PASSED" ]; then PASSED=0; fi
if [ -z "$FAILED" ]; then FAILED=0; fi
if [ "$FAILED" != "0" ]; then
  fail "forge test: $FAILED tests failed"
fi
pass "forge test: ${PASSED} passed, 0 failed"

# ── Step 3: Deploy to BSC Testnet ─────────────────────────────────────────────
info "[Step 3] Deploy contracts to BSC Testnet (chain_id=97)"
cd "$CONTRACTS_DIR"

DEPLOY_OUT=$(OWNER="$BSC_TESTNET_OWNER" PRIVATE_KEY="$BSC_TESTNET_PRIVATE_KEY" LOCK_CONFIG="$LOCK_CONFIG" \
  forge script script/Deploy.s.sol:Deploy \
    --rpc-url "$BSC_TESTNET_RPC_URL" \
    --private-key "$BSC_TESTNET_PRIVATE_KEY" \
    --broadcast \
    --slow \
  2>&1 | tee -a "$DRILL_LOG")

_extract_addr() { echo "$1" | grep "$2" | grep -o '0x[0-9a-fA-F]\{40\}' | head -1; }
TOKEN_ADDR=$(_extract_addr "$DEPLOY_OUT" "TOKEN=")
VAULT_ADDR=$(_extract_addr "$DEPLOY_OUT" "VAULT=")
SETTLER_ADDR=$(_extract_addr "$DEPLOY_OUT" "SETTLER_PROXY=")
NFA_ADDR=$(_extract_addr "$DEPLOY_OUT" "AGENT_NFA_PROXY=")
BEACON_ADDR=$(_extract_addr "$DEPLOY_OUT" "AGENT_ACCOUNT_BEACON=")
REGISTRY_ADDR=$(_extract_addr "$DEPLOY_OUT" "AGENT_ACCOUNT_REGISTRY=")
ORACLE_ADDR=$(_extract_addr "$DEPLOY_OUT" "LEARNING_ROOT_ORACLE_PROXY=")

for VAR in TOKEN_ADDR VAULT_ADDR SETTLER_ADDR NFA_ADDR BEACON_ADDR REGISTRY_ADDR ORACLE_ADDR; do
  if [ -z "${!VAR}" ]; then
    fail "Could not parse $VAR from deploy output. Check $DRILL_LOG"
  fi
done

pass "Deploy OK — all 7 addresses parsed"
info "  TOKEN   = $TOKEN_ADDR"
info "  VAULT   = $VAULT_ADDR"
info "  SETTLER = $SETTLER_ADDR"
info "  NFA     = $NFA_ADDR"
info "  BEACON  = $BEACON_ADDR"
info "  REGISTRY= $REGISTRY_ADDR"
info "  ORACLE  = $ORACLE_ADDR"

ADDR_FILE="$ARTIFACT_DIR/addresses_${TIMESTAMP}.json"
cat > "$ADDR_FILE" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "chain": "bsc-testnet",
  "chain_id": 97,
  "rpc_url": "$BSC_TESTNET_RPC_URL",
  "token":    "$TOKEN_ADDR",
  "vault":    "$VAULT_ADDR",
  "settler":  "$SETTLER_ADDR",
  "nfa":      "$NFA_ADDR",
  "beacon":   "$BEACON_ADDR",
  "registry": "$REGISTRY_ADDR",
  "oracle":   "$ORACLE_ADDR"
}
EOF
info "Addresses saved: $ADDR_FILE"

# ── Step 4: Post-deploy preflight (cast call) ─────────────────────────────────
info "[Step 4] Post-deploy preflight checks (cast call)"

check_call() {
  local label="$1"; local addr="$2"; local sig="$3"; local expected="$4"
  shift 4
  local result result_lower expected_lower
  result=$(cast call "$addr" "$sig" "$@" --rpc-url "$BSC_TESTNET_RPC_URL" 2>&1)
  result_lower=$(echo "$result" | tr '[:upper:]' '[:lower:]')
  expected_lower=$(echo "$expected" | tr '[:upper:]' '[:lower:]')
  if echo "$result_lower" | grep -q "$expected_lower"; then
    pass "$label → $result"
  else
    fail "$label: expected '$expected', got '$result'"
  fi
}

check_call "vault.settler()"              "$VAULT_ADDR"   "settler()(address)"                "$SETTLER_ADDR"
check_call "settler.vault()"             "$SETTLER_ADDR" "vault()(address)"                  "$VAULT_ADDR"
check_call "vault.settlerLocked()"       "$VAULT_ADDR"   "settlerLocked()(bool)"              "false"
check_call "vault.paused()"              "$VAULT_ADDR"   "paused()(bool)"                    "false"
check_call "settler.paused()"            "$SETTLER_ADDR" "paused()(bool)"                    "false"
check_call "oracle.paused()"             "$ORACLE_ADDR"  "paused()(bool)"                    "false"
check_call "nfa.authorizedSettlers(settler)" "$NFA_ADDR" "authorizedSettlers(address)(bool)" "true" "$SETTLER_ADDR"
check_call "nfa.owner()"                 "$NFA_ADDR"     "owner()(address)"                  "$BSC_TESTNET_OWNER"
check_call "settler.agentNFA()"          "$SETTLER_ADDR" "agentNFA()(address)"               "$NFA_ADDR"

pass "Post-deploy preflight: all checks passed"

# ── Step 5: Write .env.bsc_testnet.runtime ────────────────────────────────────
info "[Step 5] Writing .env.bsc_testnet.runtime"
RUNTIME_ENV="$ROOT_DIR/.env.bsc_testnet.runtime"
cat > "$RUNTIME_ENV" <<EOF
# Auto-generated by bsc_testnet_drill.sh — $TIMESTAMP
# BSC Testnet runtime environment

ARENA_SETTLEMENT_MODE=onchain
ARENA_CHAIN_RPC_URL=$BSC_TESTNET_RPC_URL
ARENA_SETTLER_CONTRACT=$SETTLER_ADDR
LEARNING_ROOT_ORACLE=$ORACLE_ADDR
AGENT_NFA_CONTRACT=$NFA_ADDR
AGENT_ACCOUNT_REGISTRY=$REGISTRY_ADDR

# Signer config — drill uses raw key (ALLOW_INSECURE=1 required for testnet drill)
# For production, replace with ARENA_SIGNER_KEYSTORE + ARENA_SIGNER_PASSWORD
ARENA_ALLOW_INSECURE_PRIVATE_KEY=1
ARENA_SIGNER_PRIVATE_KEY=$BSC_TESTNET_PRIVATE_KEY

ARENA_ENABLE_AGENT_ONCHAIN_REGISTRATION=1
ARENA_AGENT_NFA_MINT_TO=$BSC_TESTNET_OWNER
ARENA_AGENT_TOKEN_URI_PREFIX=ipfs://arena-agent-bsc-testnet
ARENA_AGENT_TBA_SALT=0
ARENA_SETTLEMENT_RECEIPTS_PATH=state/bsc_testnet_drill/settlement_receipts.jsonl
ARENA_LEARNING_RECEIPTS_PATH=state/bsc_testnet_drill/learning_root_receipts.jsonl
ARENA_SYNC_LEARNING_CURSOR_PATH=state/bsc_testnet_drill/sync_learning_cursor.json
EOF
pass ".env.bsc_testnet.runtime written: $RUNTIME_ENV"

# ── Step 6: CLI preflight (paper mode — before sourcing runtime env) ──────────
info "[Step 6] CLI preflight (paper mode)"
cd "$ROOT_DIR"
CLI_BIN="$ROOT_DIR/cli/dist/index.js"
if [ -f "$CLI_BIN" ]; then
  PREFLIGHT_OUT=$(ARENA_SETTLEMENT_MODE=paper \
    node "$CLI_BIN" arena preflight --config config/arena.yaml 2>&1)
  echo "$PREFLIGHT_OUT" | tee -a "$DRILL_LOG"
  if echo "$PREFLIGHT_OUT" | grep -q "\[ERROR\]"; then
    fail "CLI preflight reported ERROR(s)"
  fi
  pass "CLI preflight OK (WARNs are expected for webhook/ws/db)"
else
  warn "CLI not built — skipping preflight (run: pnpm build)"
fi

# Source runtime env for subsequent steps
set -a; source "$RUNTIME_ENV" 2>/dev/null || true; set +a

# ── Step 7: Pause / Unpause drill ─────────────────────────────────────────────
info "[Step 7] Pause/Unpause drill on all 3 contracts"

pause_unpause() {
  local name="$1"; local addr="$2"
  cast send "$addr" "pause()" --rpc-url "$BSC_TESTNET_RPC_URL" --private-key "$BSC_TESTNET_PRIVATE_KEY" \
    2>&1 | tee -a "$DRILL_LOG" > /dev/null || true
  sleep 3
  P=$(cast call "$addr" "paused()(bool)" --rpc-url "$BSC_TESTNET_RPC_URL" 2>&1)
  [ "$P" = "true" ] || fail "$name pause() failed (paused=$P)"
  cast send "$addr" "unpause()" --rpc-url "$BSC_TESTNET_RPC_URL" --private-key "$BSC_TESTNET_PRIVATE_KEY" \
    2>&1 | tee -a "$DRILL_LOG" > /dev/null || true
  sleep 3
  P=$(cast call "$addr" "paused()(bool)" --rpc-url "$BSC_TESTNET_RPC_URL" 2>&1)
  [ "$P" = "false" ] || fail "$name unpause() failed (paused=$P)"
  pass "$name pause/unpause OK"
}

pause_unpause "ArenaVault"          "$VAULT_ADDR"
pause_unpause "SeasonSettler"       "$SETTLER_ADDR"
pause_unpause "LearningRootOracle"  "$ORACLE_ADDR"

# ── Step 8: Bootstrap agent identities ────────────────────────────────────────
info "[Step 8] bootstrap-onchain"
if [ -f "$CLI_BIN" ]; then
  node "$CLI_BIN" arena bootstrap-onchain --config config/arena.yaml 2>&1 | tee -a "$DRILL_LOG" || true
  # Verify on-chain
  NFA_BAL=$(cast call "$NFA_ADDR" "balanceOf(address)(uint256)" "$BSC_TESTNET_OWNER" \
    --rpc-url "$BSC_TESTNET_RPC_URL" 2>&1)
  info "NFA balance after bootstrap: $NFA_BAL"
  pass "bootstrap-onchain completed (NFA balance=$NFA_BAL)"
else
  warn "CLI not built — skipping bootstrap-onchain"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
SUMMARY_FILE="$ARTIFACT_DIR/drill_summary_${TIMESTAMP}.json"
cat > "$SUMMARY_FILE" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "chain": "bsc-testnet",
  "chain_id": 97,
  "addresses_file": "$ADDR_FILE",
  "runtime_env_file": "$RUNTIME_ENV",
  "drill_log": "$DRILL_LOG",
  "steps_completed": [
    "forge_build",
    "forge_test_passed",
    "deploy_7_contracts",
    "post_deploy_preflight",
    "pause_unpause_drill_3_contracts",
    "bootstrap_onchain"
  ],
  "manual_steps_remaining": [
    "arena start (run $DRILL_ARENA_CYCLES cycles)",
    "arena sync-learning",
    "arena ops-report"
  ]
}
EOF

echo ""
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN} BSC TESTNET DRILL COMPLETE${NC}"
echo -e "${GREEN}============================================================${NC}"
echo ""
echo "Artifacts:"
echo "  Addresses  : $ADDR_FILE"
echo "  Runtime env: $RUNTIME_ENV"
echo "  Drill log  : $DRILL_LOG"
echo "  Summary    : $SUMMARY_FILE"
echo ""
echo "Manual next steps:"
echo "  1. source .env.bsc_testnet.runtime"
echo "  2. node cli/dist/index.js arena start --config config/arena.yaml --agent-config config/agent.yaml"
echo "  3. node cli/dist/index.js arena sync-learning --config config/arena.yaml --limit 50"
echo "  4. node cli/dist/index.js arena ops-report --config config/arena.yaml"
echo ""
echo "BSC Testnet Explorer: https://testnet.bscscan.com/address/$VAULT_ADDR"
