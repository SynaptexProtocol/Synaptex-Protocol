import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { resolveCastSigner } from './cast-signer.js';

export interface ILearningRootSubmitter {
  submit(seasonId: string, cycleId: string, cycleRoot: string): Promise<'submitted' | 'skipped'>;
}

class LoggingLearningRootSubmitter implements ILearningRootSubmitter {
  async submit(seasonId: string, cycleId: string, cycleRoot: string): Promise<'submitted'> {
    console.log('[Arena] cycle root ready (no on-chain learning submit configured)', {
      season_id: seasonId,
      cycle_id: cycleId,
      cycle_root: cycleRoot,
    });
    return 'submitted';
  }
}

interface ChainSubmitterOptions {
  rpcUrl: string;
  privateKey?: string;
  oracleAddress: string;
  receiptsPath?: string;
}

class CastLearningRootSubmitter implements ILearningRootSubmitter {
  private readonly castBin: string;
  private readonly signer = resolveCastSigner();

  constructor(private readonly opts: ChainSubmitterOptions) {
    this.castBin = process.env['ARENA_CAST_BIN']?.trim() || 'cast';
  }

  async submit(seasonId: string, cycleId: string, cycleRoot: string): Promise<'submitted' | 'skipped'> {
    const exists = await this.isAlreadySubmitted(seasonId, cycleId);
    if (exists) return 'skipped';

    const args = [
      'send',
      this.opts.oracleAddress,
      'submitCycleRoot(string,string,bytes32)',
      seasonId,
      cycleId,
      asBytes32(cycleRoot, 'cycle_root'),
      '--rpc-url',
      this.opts.rpcUrl,
      '--json',
      ...this.signer.extraArgs,
    ];

    const output = await runProcess(this.castBin, args, this.signer.env);
    const receipt = safeJsonParse(output.stdout) ?? { raw: output.stdout };
    if (this.opts.receiptsPath) {
      persistJsonLine(this.opts.receiptsPath, {
        timestamp: new Date().toISOString(),
        mode: 'learning_root_onchain_cast',
        season_id: seasonId,
        cycle_id: cycleId,
        cycle_root: cycleRoot,
        oracle: this.opts.oracleAddress,
        receipt,
      });
    }
    return 'submitted';
  }

  private async isAlreadySubmitted(seasonId: string, cycleId: string): Promise<boolean> {
    const out = await runProcess(this.castBin, [
      'call',
      this.opts.oracleAddress,
      'hasCycleRoot(string,string)(bool)',
      seasonId,
      cycleId,
      '--rpc-url',
      this.opts.rpcUrl,
    ]);
    const v = out.stdout.trim().toLowerCase();
    return v === 'true' || v === '0x1';
  }
}

export function createLearningRootSubmitter(): ILearningRootSubmitter {
  const mode = (process.env['SYNAPTEX_SETTLEMENT_MODE'] ?? '').trim().toLowerCase();
  if (mode === 'onchain') {
    const rpcUrl = process.env['SYNAPTEX_CHAIN_RPC_URL']?.trim()
      || process.env['BASE_RPC_URL']?.trim();
    const oracleAddress = process.env['LEARNING_ROOT_ORACLE']?.trim();
    if (!rpcUrl || !oracleAddress) {
      throw new Error(
        'SYNAPTEX_SETTLEMENT_MODE=onchain requires SYNAPTEX_CHAIN_RPC_URL (or BASE_RPC_URL), '
        + 'LEARNING_ROOT_ORACLE, and signer config (keystore/private-key/unlocked mode)',
      );
    }
    return new CastLearningRootSubmitter({
      rpcUrl,
      privateKey: process.env['ARENA_SETTLER_PRIVATE_KEY']?.trim(),
      oracleAddress,
      receiptsPath: process.env['ARENA_LEARNING_RECEIPTS_PATH'] ?? process.env['ARENA_SETTLEMENT_RECEIPTS_PATH'],
    });
  }
  return new LoggingLearningRootSubmitter();
}

function asBytes32(value: string, field: string): string {
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 32-byte hex value`);
  }
  return normalized;
}

function persistJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf-8');
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
