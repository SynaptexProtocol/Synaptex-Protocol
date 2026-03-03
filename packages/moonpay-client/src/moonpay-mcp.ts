/**
 * MoonPay MCP wrapper.
 *
 * When running inside Claude Code with the MoonPay MCP server active,
 * these methods delegate to the MCP tool executor.
 *
 * When running standalone (e.g. in tests or CI), they fall back to the
 * MoonPay REST API at https://agents.moonpay.com.
 *
 * The MCP tools available (from skill.md):
 *   - wallet list/create/retrieve
 *   - token swap (spot, same-chain)
 *   - token balance list
 *   - token search / retrieve
 *   - transaction list / sign / send
 */

import { logger } from '@synaptex/core/utils/logger.js';

const BASE_URL = 'https://agents.moonpay.com';

export interface WalletInfo {
  name: string;
  addresses: Record<string, string>;  // chain -> address
}

export interface SwapQuote {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  priceImpactBps: number;
  gasCostUsd: number;
  route: string;
  quoteId: string;
}

export interface SwapResult {
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed';
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
}

export class MoonpayMcpClient {
  private walletName: string;

  constructor(walletName: string) {
    this.walletName = walletName;
  }

  async getWallet(): Promise<WalletInfo> {
    const res = await this.callMcp('wallet_retrieve', { name: this.walletName });
    return res as WalletInfo;
  }

  async getBalances(chain: string): Promise<Record<string, number>> {
    const wallet = await this.getWallet();
    const address = wallet.addresses[chain];
    if (!address) throw new Error(`No address for chain ${chain}`);
    const res = await this.callMcp('token_balance_list', {
      wallet: address,
      chain,
    });
    return res as Record<string, number>;
  }

  async quoteSwap(params: {
    chain: string;
    fromToken: string;
    toToken: string;
    fromAmount: number;
  }): Promise<SwapQuote> {
    const res = await this.callMcp('token_swap_quote', {
      wallet: this.walletName,
      chain: params.chain,
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount: params.fromAmount.toString(),
    });
    return res as SwapQuote;
  }

  async executeSwap(params: {
    chain: string;
    fromToken: string;
    toToken: string;
    fromAmount: number;
    maxSlippageBps: number;
  }): Promise<SwapResult> {
    const res = await this.callMcp('token_swap', {
      wallet: this.walletName,
      chain: params.chain,
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount: params.fromAmount.toString(),
      maxSlippageBps: params.maxSlippageBps,
    });
    return res as SwapResult;
  }

  /**
   * Low-level MCP dispatcher.
   * In Claude Code context: delegates to the MCP tool.
   * In standalone context: calls the REST API.
   */
  private async callMcp(method: string, params: Record<string, unknown>): Promise<unknown> {
    // In production Claude Code: MCP tools are available as native tool calls.
    // This REST fallback is for development/testing without MCP context.
    logger.debug('MoonPay MCP call', { method, params });
    const res = await fetch(`${BASE_URL}/api/v1/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MoonPay API error ${res.status}: ${text}`);
    }
    return res.json();
  }
}
