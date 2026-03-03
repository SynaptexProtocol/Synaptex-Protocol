import type { StrategySignal } from './strategy.js';

// IPC request from TypeScript to Python
export interface IpcRequest {
  jsonrpc: '2.0';
  method: string;
  id: string;
  params: Record<string, unknown>;
}

// IPC response from Python to TypeScript
export interface IpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

// Specific IPC methods
export type IpcMethod =
  | 'process_snapshot'
  | 'record_trade'
  | 'run_backtest'
  | 'get_health'
  | 'reload_config';
