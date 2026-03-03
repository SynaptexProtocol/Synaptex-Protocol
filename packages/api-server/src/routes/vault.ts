import { Router } from 'express';
import { keccak_256 } from '@noble/hashes/sha3.js';

// ── keccak256 helper ──────────────────────────────────────────────────────────

// Solidity: keccak256(abi.encodePacked(id)) where id is a UTF-8 string
function agentKeyForId(id: string): string {
  const bytes = new TextEncoder().encode(id);
  const hash = keccak_256(bytes);
  return '0x' + Buffer.from(hash).toString('hex');
}

// ── Minimal RPC helper (no viem/ethers dependency) ────────────────────────────

interface RpcResult {
  result?: string;
  error?: { message: string };
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    });
    const json = (await res.json()) as RpcResult;
    return json.error ? null : (json.result ?? null);
  } catch {
    return null;
  }
}

// ── Precomputed 4-byte selectors ──────────────────────────────────────────────
// Generated via: cast sig "functionSig(types)"

const SEL = {
  totalSeasonPool:               '0x02fb0c5e',
  seasonSettled:                 '0xce3f4590',
  totalStakeBySeasonAgent:       '0x93423a64',
  userStakeBySeasonAgent:        '0xc6aa4ef1',
  seasonWeightWad:               '0x8e35e6d0',
  userClaimed:                   '0x4e71e0c8',
  userClaimedBySeasonAgent:      '0x3f1c5c76',
} as const;

// ── ABI encode helpers ────────────────────────────────────────────────────────

function pad32(hex: string): string {
  return hex.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

function encodeBytes32(key: string): string { return pad32(key); }
function encodeAddress(addr: string): string { return pad32(addr); }

function decodeUint256(hex: string | null): bigint {
  if (!hex || hex === '0x') return 0n;
  try { return BigInt(hex); } catch { return 0n; }
}

function decodeBool(hex: string | null): boolean {
  if (!hex || hex === '0x') return false;
  try { return BigInt(hex) !== 0n; } catch { return false; }
}

// ── Vault config ──────────────────────────────────────────────────────────────

function vaultCfg() {
  return {
    vault:  (process.env['SYNAPTEX_VAULT_ADDRESS']  ?? '').toLowerCase(),
    token:  (process.env['SYNAPTEX_TOKEN_ADDRESS']  ?? '').toLowerCase(),
    rpc:    process.env['BNB_RPC_URL'] ?? process.env['SYNAPTEX_CHAIN_RPC_URL'] ?? '',
    chainId: Number(process.env['ARENA_CHAIN_ID'] ?? '56'),
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * Vault read-only API.
 *
 * All writes (approve / stake / claim) happen client-side via the user's wallet.
 * This router only reads on-chain state and surfaces it as JSON for the UI.
 *
 * Key convention:
 *   seasonKey = keccak256(abi.encodePacked(seasonId))  — computed by frontend with viem
 *   agentKey  = keccak256(abi.encodePacked(agentId))   — same
 *   Both are passed as 0x-prefixed 32-byte hex strings in the URL.
 *
 * Routes:
 *   GET /api/v1/vault/config
 *   GET /api/v1/vault/season/:seasonKey/info
 *   GET /api/v1/vault/season/:seasonKey/agent/:agentKey/info
 *   GET /api/v1/vault/season/:seasonKey/user/:address
 */
export function createVaultRouter(): Router {
  const router = Router();

  // ── /vault/keyhash?id=<agentId|seasonId> ──────────────────────────────────
  // Computes keccak256(abi.encodePacked(id)) server-side (SubtleCrypto in the
  // browser does not support keccak256, only SHA-256).
  router.get('/keyhash', (req, res) => {
    const id = String(req.query['id'] ?? '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'Missing ?id= query param' });
      return;
    }
    const key = agentKeyForId(id);
    res.json({ ok: true, id, key });
  });

  // ── /vault/config ─────────────────────────────────────────────────────────
  router.get('/config', (_req, res) => {
    const cfg = vaultCfg();
    res.json({
      ok: true,
      data: {
        vault_address: cfg.vault  || null,
        token_address: cfg.token  || null,
        chain_id:      cfg.chainId,
        rpc_url:       cfg.rpc    || null,
      },
    });
  });

  // ── /vault/season/:seasonKey/info ─────────────────────────────────────────
  router.get('/season/:seasonKey/info', async (req, res) => {
    const { vault, rpc } = vaultCfg();
    if (!vault || !rpc) { res.json({ ok: true, data: { available: false } }); return; }
    const sk = encodeBytes32(req.params['seasonKey'] ?? '');
    try {
      const [poolHex, settledHex] = await Promise.all([
        ethCall(rpc, vault, SEL.totalSeasonPool + sk),
        ethCall(rpc, vault, SEL.seasonSettled   + sk),
      ]);
      res.json({
        ok: true,
        data: {
          season_key:     req.params['seasonKey'],
          total_pool_wei: decodeUint256(poolHex).toString(),
          settled:        decodeBool(settledHex),
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── /vault/season/:seasonKey/agent/:agentKey/info ─────────────────────────
  router.get('/season/:seasonKey/agent/:agentKey/info', async (req, res) => {
    const { vault, rpc } = vaultCfg();
    if (!vault || !rpc) { res.json({ ok: true, data: { available: false } }); return; }
    const sk = encodeBytes32(req.params['seasonKey'] ?? '');
    const ak = encodeBytes32(req.params['agentKey']  ?? '');
    try {
      const [stakeHex, weightHex] = await Promise.all([
        ethCall(rpc, vault, SEL.totalStakeBySeasonAgent + sk + ak),
        ethCall(rpc, vault, SEL.seasonWeightWad         + sk + ak),
      ]);
      res.json({
        ok: true,
        data: {
          season_key:      req.params['seasonKey'],
          agent_key:       req.params['agentKey'],
          total_stake_wei: decodeUint256(stakeHex).toString(),
          weight_wad:      decodeUint256(weightHex).toString(),
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── /vault/season/:seasonKey/user/:address ────────────────────────────────
  // Query param: ?agents=key1,key2,key3  (keccak256 of agent IDs, comma-separated)
  // The frontend computes these with viem's keccak256(encodePacked(agentId)).
  router.get('/season/:seasonKey/user/:address', async (req, res) => {
    const { vault, rpc } = vaultCfg();
    if (!vault || !rpc) { res.json({ ok: true, data: { available: false } }); return; }

    const sk = encodeBytes32(req.params['seasonKey'] ?? '');
    const ua = encodeAddress(req.params['address']   ?? '');

    const agentsParam = String(req.query['agents'] ?? '').trim();
    if (!agentsParam) {
      res.status(400).json({ ok: false, error: 'Missing ?agents= query param (comma-separated keccak256 keys)' });
      return;
    }
    const agentKeys = agentsParam.split(',').map(k => k.trim()).filter(Boolean);

    try {
      const [claimedHex, settledHex, poolHex] = await Promise.all([
        ethCall(rpc, vault, SEL.userClaimed      + sk + ua),
        ethCall(rpc, vault, SEL.seasonSettled    + sk),
        ethCall(rpc, vault, SEL.totalSeasonPool  + sk),
      ]);

      const claimed   = decodeBool(claimedHex);
      const settled   = decodeBool(settledHex);
      const totalPool = decodeUint256(poolHex);

      const agentData = await Promise.all(agentKeys.map(async (agentKey) => {
        const ak = encodeBytes32(agentKey);
        const [userStakeHex, totalStakeHex, weightHex, agentClaimedHex] = await Promise.all([
          ethCall(rpc, vault, SEL.userStakeBySeasonAgent     + sk + ak + ua),
          ethCall(rpc, vault, SEL.totalStakeBySeasonAgent    + sk + ak),
          ethCall(rpc, vault, SEL.seasonWeightWad            + sk + ak),
          ethCall(rpc, vault, SEL.userClaimedBySeasonAgent   + sk + ak + ua),
        ]);

        const userStake    = decodeUint256(userStakeHex);
        const totalStake   = decodeUint256(totalStakeHex);
        const weight       = decodeUint256(weightHex);
        const agentClaimed = decodeBool(agentClaimedHex);

        // payout = (pool × weight × userStake) / (WAD × totalStake)
        let claimableWei = 0n;
        if (settled && !agentClaimed && userStake > 0n && totalStake > 0n && weight > 0n) {
          claimableWei = (totalPool * weight * userStake) / (10n ** 18n * totalStake);
        }

        return {
          agent_key:       agentKey,
          user_stake_wei:  userStake.toString(),
          total_stake_wei: totalStake.toString(),
          weight_wad:      weight.toString(),
          claimable_wei:   claimableWei.toString(),
          agent_claimed:   agentClaimed,
        };
      }));

      const totalClaimableWei = agentData.reduce(
        (s, a) => s + BigInt(a.claimable_wei), 0n,
      );

      res.json({
        ok: true,
        data: {
          season_key:          req.params['seasonKey'],
          user:                req.params['address'],
          settled,
          claimed,
          total_pool_wei:      totalPool.toString(),
          total_claimable_wei: totalClaimableWei.toString(),
          agents:              agentData,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  return router;
}
