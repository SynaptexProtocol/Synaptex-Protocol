import type { ApprovedDecision, SwapReceipt, ISwapExecutor, SwapExecutorConfig } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import { logTrade } from '../utils/trade-logger.js';

// 0x Swap API v2 for BNB Chain
const ZEROX_API_BASE = 'https://bsc.api.0x.org';

// BNB Chain token addresses
const TOKEN_ADDRESSES: Record<string, string> = {
  USDT: '0x55d398326f99059fF775485246999027B3197955',  // BSC-USDT
  BNB:  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',  // WBNB
  BTCB: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',  // BTCB
};

/**
 * 0x Swap API v2 executor on BNB Chain.
 *
 * Required env / config.options:
 *   apiKey     — 0x API key (falls back to ZEROX_API_KEY)
 *   rpcUrl     — BSC RPC URL (falls back to UNISWAP_RPC_URL / ARENA_CHAIN_RPC_URL)
 *   privateKey — signer private key (falls back to UNISWAP_PRIVATE_KEY)
 *   slippageBps — max slippage (default 100 = 1%)
 *
 * Flow:
 *   1. GET /swap/permit2/quote to get calldata + permit2 signature request
 *   2. Sign permit2 if required
 *   3. Broadcast the transaction via viem
 *
 * NOTE: permit2 allowance setup is required once per token per wallet.
 * This implementation assumes allowance is already set.
 * See https://0x.org/docs/0x-swap-api/guides/swap-tokens-with-0x-swap-api
 */
export class ZeroXSwapExecutor implements ISwapExecutor {
  private readonly apiKey: string;
  private readonly rpcUrl: string;
  private readonly privateKey: string;
  private readonly slippageBps: number;

  constructor(private readonly config: SwapExecutorConfig) {
    this.apiKey = (config.options?.['apiKey'] as string | undefined)
      || process.env['ZEROX_API_KEY']
      || '';
    this.rpcUrl = (config.options?.['rpcUrl'] as string | undefined)
      || process.env['UNISWAP_RPC_URL']
      || process.env['ARENA_CHAIN_RPC_URL']
      || '';
    this.privateKey = (config.options?.['privateKey'] as string | undefined)
      || process.env['UNISWAP_PRIVATE_KEY']
      || '';
    this.slippageBps = (config.options?.['slippageBps'] as number | undefined) ?? 100;

    if (!this.apiKey) throw new Error('ZeroXSwapExecutor: apiKey is required (set ZEROX_API_KEY or config.options.apiKey)');
    if (!this.rpcUrl) throw new Error('ZeroXSwapExecutor: rpcUrl is required (set UNISWAP_RPC_URL or config.options.rpcUrl)');
    if (!this.privateKey) throw new Error('ZeroXSwapExecutor: privateKey is required (set UNISWAP_PRIVATE_KEY or config.options.privateKey)');
  }

  async execute(decision: ApprovedDecision): Promise<SwapReceipt | null> {
    const { signal } = decision;
    if (!signal.amountUsd) {
      logger.warn('No amountUsd on signal, skipping', { strategyId: signal.strategyId });
      return null;
    }

    const isBuy = signal.action === 'BUY';
    const tokenInSymbol = isBuy ? 'USDT' : signal.token;
    const tokenOutSymbol = isBuy ? signal.token : 'USDT';
    const tokenIn = TOKEN_ADDRESSES[tokenInSymbol];
    const tokenOut = TOKEN_ADDRESSES[tokenOutSymbol];

    if (!tokenIn) throw new Error(`ZeroXSwapExecutor: unknown token ${tokenInSymbol}`);
    if (!tokenOut) throw new Error(`ZeroXSwapExecutor: unknown token ${tokenOutSymbol}`);

    const { createWalletClient, createPublicClient, http, parseUnits } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { bsc } = await import('viem/chains');

    const account = privateKeyToAccount(this.privateKey as `0x${string}`);

    // USDT on BSC = 18 decimals, WBNB/BTCB = 18
    const decimalsIn = 18;
    const sellAmount = parseUnits(decision.finalAmountUsd.toFixed(18), decimalsIn).toString();

    // Step 1: Get quote from 0x API v2
    const url = new URL(`${ZEROX_API_BASE}/swap/permit2/quote`);
    url.searchParams.set('chainId', '56');
    url.searchParams.set('sellToken', tokenIn);
    url.searchParams.set('buyToken', tokenOut);
    url.searchParams.set('sellAmount', sellAmount);
    url.searchParams.set('slippageBps', this.slippageBps.toString());
    url.searchParams.set('taker', account.address);

    const quoteRes = await fetch(url.toString(), {
      headers: { '0x-api-key': this.apiKey, '0x-version': 'v2' },
    });
    if (!quoteRes.ok) {
      const text = await quoteRes.text();
      throw new Error(`0x quote failed ${quoteRes.status}: ${text}`);
    }
    const quote = await quoteRes.json() as {
      transaction: { to: string; data: string; value: string; gas: string; gasPrice: string };
      buyAmount: string;
      permit2?: { eip712: unknown };
    };

    const walletClient = createWalletClient({ account, chain: bsc, transport: http(this.rpcUrl) });

    // Step 2: Sign permit2 if required (most 0x v2 routes need it)
    let signatureData = '';
    if (quote.permit2?.eip712) {
      signatureData = await walletClient.signTypedData(quote.permit2.eip712 as Parameters<typeof walletClient.signTypedData>[0]);
    }

    // Step 3: Broadcast transaction
    // If permit2 signature present, append it to calldata per 0x docs
    const calldata = signatureData
      ? (quote.transaction.data + signatureData.slice(2)) as `0x${string}`
      : quote.transaction.data as `0x${string}`;

    const publicClient = createPublicClient({ chain: bsc, transport: http(this.rpcUrl) });
    const txHash = await walletClient.sendTransaction({
      to: quote.transaction.to as `0x${string}`,
      data: calldata,
      value: BigInt(quote.transaction.value ?? '0'),
    });

    const decimalsOut = 18; // All BNB chain tokens in our registry = 18 decimals
    const toAmount = Number(BigInt(quote.buyAmount)) / 10 ** decimalsOut;

    const receipt: SwapReceipt = {
      txHash,
      fromToken: tokenInSymbol,
      toToken: tokenOutSymbol,
      fromAmount: decision.finalAmountUsd,
      toAmount,
      gasPaidUsd: 0,
      timestamp: new Date().toISOString(),
      chain: 'bnb',
    };

    logTrade(this.config.tradesLogPath, signal.strategyId, signal.action as 'BUY' | 'SELL', signal.token, decision, receipt, false);
    logger.info('[0X] Swap submitted', { txHash, from: tokenInSymbol, to: tokenOutSymbol, toAmount });
    return receipt;
  }
}
