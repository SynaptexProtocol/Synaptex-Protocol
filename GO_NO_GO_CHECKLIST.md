# Arena Protocol — GO / NO-GO Mainnet Checklist

Generated: 2026-02-25 (post security batch 5, anvil gate v2)

## Legend
- [x] DONE — verified in this session
- [ ] TODO — required before mainnet launch
- [!] BLOCKER — must resolve before launch

---

## I. Contract Engineering

- [x] forge test: 57 passed, 0 failed
- [x] AgentAccount: authorization is owner-scoped (no stale auth across NFT transfer)
- [x] ArenaVault: MAX_AGENTS_PER_SEASON=256 (DoS guard on claim loop)
- [x] ArenaVault: nonReentrant on stake/claim/claimAgent
- [x] ArenaVault: claimAgent + claimAgents (bounded claim paths)
- [x] AgentNFA: safeTransferFrom + IERC721Receiver check
- [x] ArenaToken: cap>0 enforced, totalSupply never exceeds cap
- [x] Ownable (ArenaOwnable): two-step ownership (pendingOwner + acceptOwnership)
- [x] AgentAccount: rescue methods (guardian-gated, owner==address(0) guard)
- [x] UUPS upgrades: _disableInitializers() in all impl constructors
- [x] Storage layout: no slot reorder in AgentNFA/SeasonSettler/LearningRootOracle/AgentAccount

## II. Deployment & Wiring

- [x] Deploy script: all 7 contracts in single broadcast
- [x] Auto-wiring: vault.setSettler, settler.setAgentNFA, nfa.setAuthorizedSettler
- [x] Post-deploy preflight: 8/8 cast call checks pass
- [x] LOCK_CONFIG path: lockSettler() + lockVault() tested
- [ ] Base Sepolia testnet deploy + verification (complete before mainnet)
- [ ] Base mainnet deploy receipt + address record
- [ ] Etherscan/Blockscout contract verification (after mainnet deploy)

## III. Operations Readiness

- [x] CLI preflight command functional (paper + onchain modes)
- [x] CLI bootstrap-onchain: idempotent NFA+TBA registration
- [x] CLI arena start: cycle executes, commitments written
- [x] CLI sync-learning: cursor-based backlog replay
- [x] CLI ops-report: DLQ=0, season/leaderboard populated
- [x] pause/unpause drill: all 3 contracts verified
- [x] two-step ownership drill: ArenaVault verified
- [x] sepolia_drill.sh: all bugs fixed, runs end-to-end (Steps 1-8 PASS on anvil)
- [x] Keystore signer: test keystore created, preflight PASS in onchain+keystore mode
- [x] preflight 0 error 0 warn: verified with ARENA_ALERT_WEBHOOK_URL + ARENA_WS_AUTH_TOKEN + ARENA_DATABASE_URL
- [ ] Base Sepolia end-to-end drill with real RPC (fill .env.sepolia, run scripts/sepolia_drill.sh)
- [ ] Keystore file created and preflight verified with ARENA_SIGNER_KEYSTORE

## IV. Security

- [x] Raw private-key signer blocked by default in onchain mode
- [x] ARENA_ALLOW_INSECURE_PRIVATE_KEY=1 required to override
- [x] No ETH_PRIVATE_KEY injection (Foundry 1.6.0-rc1 limitation acknowledged)
- [!] EXTERNAL SECURITY AUDIT — **BLOCKER**: protocol has not been externally audited
- [x] Slither static analysis run: 31 findings → 28 (HIGH resolved, LOW/INFO documented in AUDIT_FIXLOG.md)
- [ ] Bug bounty or audit firm engagement confirmed
- [ ] Emergency multisig or time-lock for owner role (production key custody)
- [ ] Key ceremony SOP documented and tested

## V. Infrastructure

- [ ] ARENA_ALERT_WEBHOOK_URL configured (monitoring/paging)
- [ ] ARENA_WS_AUTH_TOKEN set (WebSocket authentication)
- [ ] ARENA_DATABASE_URL connected (move off local JSON store for production)
- [ ] Agent token URI prefix points to production IPFS/metadata server
- [ ] API server TLS termination (nginx/reverse proxy) in production
- [ ] Process manager (PM2/systemd) config tested

## VI. Final GO Gate

All of the following must be true before sending mainnet transactions:

- [x] forge test 57/0 pass
- [x] Anvil local gate: all drills pass
- [x] Storage layout: no reorder
- [ ] Base Sepolia gate: all drills pass
- [!] External security audit complete (BLOCKER)
- [ ] Etherscan contract verification complete
- [ ] Keystore-mode preflight passes on target chain
- [ ] Emergency pause tested on live testnet before mainnet traffic

---

## Current Status

**Engineering gate: PASS**
**Launch blocker: External security audit not complete**

> Safe to proceed to Base Sepolia testnet deployment and integration testing.
> Mainnet deployment requires external audit completion.
