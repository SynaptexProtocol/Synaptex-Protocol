# Contracts

This directory contains the on-chain settlement contracts for Arena Phase 2.

## Contracts

- `ArenaToken.sol`: minimal ERC20 token (`ARENA`)
- `ArenaVault.sol`: stake vault and season payout claim logic
- `SeasonSettler.sol`: accepts season result (`leaderboardHash`, `merkleRoot`, weights) and settles vault
- `AgentNFA.sol`: agent identity NFT (ERC-721 style)
- `AgentAccountRegistry.sol` + `AgentAccount.sol`: ERC-6551-style token bound account layer
- `LearningRootOracle.sol`: cycle-level learning root commitment store

Key security properties:
- `ArenaToken` uses immutable supply cap (`maxSupply` must be non-zero).
- `ArenaOwnable` uses two-step ownership transfer (`transferOwnership` -> `acceptOwnership`).
- `AgentAccount` includes emergency rescue path via registry/beacon owner when account owner is unavailable.

## Deploy (Foundry)

```bash
cd contracts
forge build
```

Example deployment sequence:

```bash
export RPC_URL="https://mainnet.base.org"
export PK="0x..."
export OWNER="0xYourOwner"

# 1) Token (mint initial supply to OWNER)
TOKEN=$(forge create src/ArenaToken.sol:ArenaToken \
  --rpc-url "$RPC_URL" --private-key "$PK" \
  --constructor-args "$OWNER" 100000000000000000000000000 1000000000000000000000000000 \
  --json | jq -r .deployedTo)

# 2) Vault
VAULT=$(forge create src/ArenaVault.sol:ArenaVault \
  --rpc-url "$RPC_URL" --private-key "$PK" \
  --constructor-args "$TOKEN" "$OWNER" \
  --json | jq -r .deployedTo)

# 3) Settler
SETTLER=$(forge create src/SeasonSettler.sol:SeasonSettler \
  --rpc-url "$RPC_URL" --private-key "$PK" \
  --constructor-args "$VAULT" "$OWNER" \
  --json | jq -r .deployedTo)

# 4) Agent identity NFA
AGENT_NFA=$(forge create src/AgentNFA.sol:AgentNFA \
  --rpc-url "$RPC_URL" --private-key "$PK" \
  --constructor-args "$OWNER" \
  --json | jq -r .deployedTo)

# 5) Agent account registry
AGENT_REGISTRY=$(forge create src/AgentAccountRegistry.sol:AgentAccountRegistry \
  --rpc-url "$RPC_URL" --private-key "$PK" \
  --json | jq -r .deployedTo)

# 6) Learning root oracle
LEARNING_ORACLE=$(forge create src/LearningRootOracle.sol:LearningRootOracle \
  --rpc-url "$RPC_URL" --private-key "$PK" \
  --constructor-args "$OWNER" \
  --json | jq -r .deployedTo)

# 7) Wire vault -> settler
cast send "$VAULT" "setSettler(address)" "$SETTLER" \
  --rpc-url "$RPC_URL" --private-key "$PK"
```

## Runtime submit from CLI

The CLI can submit season settlement on-chain via `cast send`:

- `ARENA_SETTLEMENT_MODE=onchain`
- `ARENA_SETTLER_CONTRACT=<SeasonSettler address>`
- `ARENA_SETTLER_PRIVATE_KEY=<owner key>`
- `ARENA_CHAIN_RPC_URL=<Base RPC>`

Optional:

- `ARENA_SETTLEMENT_RECEIPTS_PATH=state/arena/settlement_receipts.jsonl`

## Storage Layout Check (UUPS/Beacon release gate)

Before any upgrade release, run:

```bash
pwsh script/check-storage-layout.ps1
```

This writes current storage layouts to `contracts/storage-layout/*.json` for:
- `AgentNFA`
- `SeasonSettler`
- `LearningRootOracle`
- `AgentAccount`
