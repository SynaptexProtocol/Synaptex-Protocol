import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { resolveCastSigner } from './cast-signer.js';

export interface IAgentIdentityRegistrar {
  ensureAgent(agentId: string, preferredOwner?: string): Promise<void>;
}

class NoopAgentIdentityRegistrar implements IAgentIdentityRegistrar {
  async ensureAgent(_agentId: string, _preferredOwner?: string): Promise<void> {
    // no-op
  }
}

interface CastRegistrarOptions {
  rpcUrl: string;
  privateKey?: string;
  nfaContract: string;
  registryContract: string;
  fallbackMintTo: string;
  tokenUriPrefix: string;
  tbaSalt: number;
  logPath?: string;
}

class CastAgentIdentityRegistrar implements IAgentIdentityRegistrar {
  private readonly castBin: string;
  private readonly signer = resolveCastSigner();

  constructor(private readonly opts: CastRegistrarOptions) {
    this.castBin = process.env['ARENA_CAST_BIN']?.trim() || 'cast';
  }

  async ensureAgent(agentId: string, preferredOwner?: string): Promise<void> {
    const key = await this.cast(['keccak', agentId]);
    let tokenId = await this.readTokenIdByKey(key);
    const mintTo = this.resolveOwner(preferredOwner);
    const tokenUri = `${this.opts.tokenUriPrefix.replace(/\/$/, '')}/${agentId}`;

    if (tokenId === 0n) {
      await this.cast([
        'send',
        this.opts.nfaContract,
        'mintAgent(address,string,string)',
        mintTo,
        agentId,
        tokenUri,
        '--rpc-url',
        this.opts.rpcUrl,
        '--json',
        ...this.signer.extraArgs,
      ]);
      tokenId = await this.readTokenIdByKey(key);
      if (tokenId === 0n) {
        throw new Error(`Agent NFA mint failed for ${agentId}`);
      }
    }

    const chainIdRaw = await this.cast(['chain-id', '--rpc-url', this.opts.rpcUrl]);
    const chainId = BigInt(chainIdRaw.trim());

    // Compute deterministic TBA address first (read-only, no gas)
    const accountAddress = await this.cast([
      'call',
      this.opts.registryContract,
      'accountAddress(address,uint256,uint256,uint256)(address)',
      this.opts.nfaContract,
      tokenId.toString(),
      chainId.toString(),
      String(this.opts.tbaSalt),
      '--rpc-url',
      this.opts.rpcUrl,
    ]);

    // Only deploy TBA if no code exists at that address (idempotent on restart)
    const code = await this.cast(['code', accountAddress.trim(), '--rpc-url', this.opts.rpcUrl]);
    if (code.trim() === '0x') {
      await this.cast([
        'send',
        this.opts.registryContract,
        'createAccount(address,uint256,uint256,uint256)',
        this.opts.nfaContract,
        tokenId.toString(),
        chainId.toString(),
        String(this.opts.tbaSalt),
        '--rpc-url',
        this.opts.rpcUrl,
        '--json',
        ...this.signer.extraArgs,
      ]);
    }

    if (this.opts.logPath) {
      persistJsonLine(this.opts.logPath, {
        timestamp: new Date().toISOString(),
        agent_id: agentId,
        token_id: tokenId.toString(),
        account: accountAddress.trim(),
        mint_to: mintTo,
      });
    }
  }

  private resolveOwner(preferredOwner?: string): string {
    if (preferredOwner && isHexAddress(preferredOwner)) return preferredOwner;
    if (isHexAddress(this.opts.fallbackMintTo)) return this.opts.fallbackMintTo;
    throw new Error(
      'On-chain agent registration requires valid owner address: '
      + 'agent.owner or ARENA_AGENT_NFA_MINT_TO',
    );
  }

  private async readTokenIdByKey(key: string): Promise<bigint> {
    const out = await this.cast([
      'call',
      this.opts.nfaContract,
      'tokenByAgentKey(bytes32)(uint256)',
      key.trim(),
      '--rpc-url',
      this.opts.rpcUrl,
    ]);
    const normalized = out.trim();
    if (/^0x[0-9a-fA-F]+$/.test(normalized)) return BigInt(normalized);
    if (/^\d+$/.test(normalized)) return BigInt(normalized);
    throw new Error(`Unexpected tokenByAgentKey result: ${normalized}`);
  }

  private async cast(args: string[]): Promise<string> {
    const output = await runProcess(this.castBin, args, this.signer.env);
    return output.stdout;
  }
}

export function createAgentIdentityRegistrar(): IAgentIdentityRegistrar {
  const enabled = (process.env['ARENA_ENABLE_AGENT_ONCHAIN_REGISTRATION'] ?? '').trim() === '1';
  if (!enabled) return new NoopAgentIdentityRegistrar();

  const rpcUrl = process.env['SYNAPTEX_CHAIN_RPC_URL']?.trim() || process.env['BASE_RPC_URL']?.trim();
  const nfaContract = process.env['AGENT_NFA_CONTRACT']?.trim();
  const registryContract = process.env['AGENT_ACCOUNT_REGISTRY']?.trim();
  const fallbackMintTo = process.env['ARENA_AGENT_NFA_MINT_TO']?.trim() ?? '';
  const tokenUriPrefix = process.env['ARENA_AGENT_TOKEN_URI_PREFIX']?.trim() ?? 'ipfs://arena-agent';
  const tbaSalt = Number(process.env['ARENA_AGENT_TBA_SALT'] ?? '0');
  if (!rpcUrl || !nfaContract || !registryContract || !Number.isFinite(tbaSalt)) {
    throw new Error(
      'On-chain agent registration requires SYNAPTEX_CHAIN_RPC_URL (or BASE_RPC_URL), '
      + 'AGENT_NFA_CONTRACT, AGENT_ACCOUNT_REGISTRY, ARENA_AGENT_TBA_SALT, '
      + 'and signer config (keystore/private-key/unlocked mode)',
    );
  }
  return new CastAgentIdentityRegistrar({
    rpcUrl,
    privateKey: process.env['ARENA_SETTLER_PRIVATE_KEY']?.trim(),
    nfaContract,
    registryContract,
    fallbackMintTo,
    tokenUriPrefix,
    tbaSalt,
    logPath: process.env['ARENA_AGENT_REGISTRATION_LOG_PATH'],
  });
}

function runProcess(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const outPath = join(tmpdir(), `arena-cast-out-${randomUUID()}.log`);
    const errPath = join(tmpdir(), `arena-cast-err-${randomUUID()}.log`);
    const outFd = openSync(outPath, 'w');
    const errFd = openSync(errPath, 'w');
    const child = spawn(cmd, args, {
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, ...env },
    });
    child.on('error', (err) => {
      closeSync(outFd);
      closeSync(errFd);
      try { unlinkSync(outPath); } catch {}
      try { unlinkSync(errPath); } catch {}
      reject(new Error(`Failed to start ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      closeSync(outFd);
      closeSync(errFd);
      const stdout = readFileSync(outPath, 'utf-8').trim();
      const stderr = readFileSync(errPath, 'utf-8').trim();
      try { unlinkSync(outPath); } catch {}
      try { unlinkSync(errPath); } catch {}
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} exited with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

function persistJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf-8');
}

function isHexAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(v);
}
