import net from 'net';
import { createInterface } from 'readline';
import type { MarketSnapshot, SignalBatch, StrategySignal } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';

/** Raw signal shape as returned by Python (snake_case) */
interface RawSignal {
  strategy_id: string;
  action: StrategySignal['action'];
  token: string;
  amount_usd?: number;
  target_price?: number;
  confidence: number;
  rationale: string;
  requires_ai_approval: boolean;
}

interface RawSignalBatch {
  cycle_id: string;
  timestamp: string;
  signals: RawSignal[];
  risk_vetoed: boolean;
  veto_reason?: string;
}

function normalizeSignalBatch(raw: RawSignalBatch): SignalBatch {
  return {
    cycleId: raw.cycle_id,
    timestamp: raw.timestamp,
    riskVetoed: raw.risk_vetoed,
    vetoReason: raw.veto_reason,
    signals: raw.signals.map((s) => ({
      strategyId: s.strategy_id,
      action: s.action,
      token: s.token,
      amountUsd: s.amount_usd,
      targetPrice: s.target_price,
      confidence: s.confidence,
      rationale: s.rationale,
      requiresAiApproval: s.requires_ai_approval,
    })),
  };
}


export interface IpcConfig {
  host: string;
  port: number;
  timeoutMs: number;
}

export class IpcClient {
  private socket: net.Socket | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private pendingRequests = new Map<string, (result: unknown, error?: string) => void>();
  private reqSeq = 0;

  constructor(private readonly config: IpcConfig) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.config.host, port: this.config.port });
      sock.once('connect', () => {
        this.socket = sock;
        this.rl = createInterface({ input: sock, crlfDelay: Infinity });
        this.rl.on('line', (line) => this.handleLine(line));
        sock.on('error', (err) => logger.error('IPC socket error', { error: err.message }));
        sock.on('close', () => {
          logger.warn('IPC connection closed');
          this.socket = null;
        });
        resolve();
      });
      sock.once('error', reject);
    });
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line) as { id: string; result?: unknown; error?: { message: string } };
      const cb = this.pendingRequests.get(msg.id);
      if (cb) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          cb(null, msg.error.message);
        } else {
          cb(msg.result);
        }
      }
    } catch (err) {
      logger.error('IPC parse error', { line, error: String(err) });
    }
  }

  async processSnapshot(snapshot: MarketSnapshot): Promise<SignalBatch> {
    const id = `cycle-${snapshot.cycleId}-${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('IPC not connected'));
        return;
      }
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`IPC timeout for ${id}`));
      }, this.config.timeoutMs);

      this.pendingRequests.set(id, (result, error) => {
        clearTimeout(timeout);
        if (error) reject(new Error(error));
        else resolve(normalizeSignalBatch(result as RawSignalBatch));
      });

      const msg = JSON.stringify({
        jsonrpc: '2.0',
        method: 'process_snapshot',
        id,
        params: { snapshot },
      }) + '\n';
      this.socket.write(msg);
    });
  }

  async getHealth(): Promise<{ status: string; strategies: string[] }> {
    const id = `health-${Date.now()}`;
    return new Promise((resolve, reject) => {
      if (!this.socket) { reject(new Error('IPC not connected')); return; }
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Health check timeout'));
      }, 3000);
      this.pendingRequests.set(id, (result, error) => {
        clearTimeout(timeout);
        if (error) reject(new Error(error));
        else resolve(result as { status: string; strategies: string[] });
      });
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'get_health', id, params: {} }) + '\n');
    });
  }

  async recordTrade(token: string): Promise<void> {
    const id = `trade-${Date.now()}-${token}`;
    return new Promise((resolve, reject) => {
      if (!this.socket) { reject(new Error('IPC not connected')); return; }
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('record_trade timeout'));
      }, this.config.timeoutMs);
      this.pendingRequests.set(id, (_result, error) => {
        clearTimeout(timeout);
        if (error) reject(new Error(error));
        else resolve();
      });
      this.socket.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'record_trade',
        id,
        params: { token },
      }) + '\n');
    });
  }

  disconnect(): void {
    this.rl?.close();
    this.socket?.destroy();
    this.socket = null;
  }
}
