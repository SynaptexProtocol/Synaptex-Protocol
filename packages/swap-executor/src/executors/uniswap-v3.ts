import type { ApprovedDecision, SwapReceipt, ISwapExecutor, SwapExecutorConfig } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import { logTrade } from '../utils/trade-logger.js';

// PancakeSwap V3 on BNB Chain — Uniswap V3-compatible interface
const UNISWAP_V3_ROUTER = '0x1b81D678ffb9C0263b24A97847620C99d213eB14';
const UNISWAP_V3_QUOTER_V2 = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

// BNB Chain token addresses
const TOKEN_ADDRESSES: Record<string, string> = {
  USDT: '0x55d398326f99059fF775485246999027B3197955',  // BSC-USDT (18 decimals)
  BNB:  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',  // WBNB
  BTCB: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',  // BTCB
};

const SWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    name: 'exactOutputSingle',
    type: 'function',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'amountOut', type: 'uint256' },
        { name: 'amountInMaximum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountIn', type: 'uint256' }],
  },
] as const;

const ERC20_ABI = [
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'decimals', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

const QUOTER_V2_ABI = [
  {
    name: 'quoteExactOutputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'fee', type: 'uint24' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export class UniswapV3SwapExecutor implements ISwapExecutor {
  private readonly rpcUrl: string;
  private readonly privateKey: string;
  private readonly slippageBps: number;
  private readonly quoterAddress: `0x${string}`;
  private readonly allowUnsafeZeroMinOut: boolean;
  private readonly configuredMinOut: bigint | null;

  constructor(private readonly config: SwapExecutorConfig) {
    this.rpcUrl = (config.options?.['rpcUrl'] as string | undefined)
      || process.env['UNISWAP_RPC_URL']
      || process.env['ARENA_CHAIN_RPC_URL']
      || '';
    this.privateKey = (config.options?.['privateKey'] as string | undefined)
      || process.env['UNISWAP_PRIVATE_KEY']
      || '';
    this.slippageBps = (config.options?.['slippageBps'] as number | undefined) ?? 100;
    this.quoterAddress = ((config.options?.['quoterAddress'] as string | undefined)
      || process.env['UNISWAP_V3_QUOTER']
      || UNISWAP_V3_QUOTER_V2) as `0x${string}`;
    this.allowUnsafeZeroMinOut = ((config.options?.['allowUnsafeZeroMinOut'] as boolean | undefined) ?? false) === true;

    const minOutOpt = config.options?.['amountOutMinimum'];
    if (typeof minOutOpt === 'bigint') this.configuredMinOut = minOutOpt;
    else if (typeof minOutOpt === 'string' && /^\d+$/.test(minOutOpt)) this.configuredMinOut = BigInt(minOutOpt);
    else if (typeof minOutOpt === 'number' && Number.isFinite(minOutOpt) && minOutOpt >= 0) this.configuredMinOut = BigInt(Math.floor(minOutOpt));
    else this.configuredMinOut = null;

    if (!this.rpcUrl) throw new Error('UniswapV3SwapExecutor: rpcUrl is required (set UNISWAP_RPC_URL or config.options.rpcUrl)');
    if (!this.privateKey) throw new Error('UniswapV3SwapExecutor: privateKey is required (set UNISWAP_PRIVATE_KEY or config.options.privateKey)');
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

    if (!tokenIn) throw new Error(`UniswapV3SwapExecutor: unknown token ${tokenInSymbol}`);
    if (!tokenOut) throw new Error(`UniswapV3SwapExecutor: unknown token ${tokenOutSymbol}`);

    const { createWalletClient, createPublicClient, http, parseUnits } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { bsc } = await import('viem/chains');

    const account = privateKeyToAccount(this.privateKey as `0x${string}`);
    const publicClient = createPublicClient({ chain: bsc, transport: http(this.rpcUrl) });
    const walletClient = createWalletClient({ account, chain: bsc, transport: http(this.rpcUrl) });

    const decimalsInRaw = await publicClient.readContract({
      address: tokenIn as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    const decimalsIn = Number(decimalsInRaw);

    let txHash: `0x${string}`;
    if (isBuy) {
      const amountIn = parseUnits(decision.finalAmountUsd.toFixed(18), decimalsIn);
      const amountOutMinimum = this.resolveAmountOutMinimum();

      await walletClient.writeContract({
        address: tokenIn as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [UNISWAP_V3_ROUTER as `0x${string}`, amountIn],
      });

      txHash = await walletClient.writeContract({
        address: UNISWAP_V3_ROUTER as `0x${string}`,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [{
          tokenIn: tokenIn as `0x${string}`,
          tokenOut: tokenOut as `0x${string}`,
          fee: 3000,
          recipient: account.address,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        }],
      });
    } else {
      // SELL: enforce exact USDT out target and cap token-in with quote + slippage.
      const amountOut = parseUnits(decision.finalAmountUsd.toFixed(18), 18); // USDT on BSC = 18 decimals
      const quote = await publicClient.readContract({
        address: this.quoterAddress,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactOutputSingle',
        args: [{
          tokenIn: tokenIn as `0x${string}`,
          tokenOut: tokenOut as `0x${string}`,
          amount: amountOut,
          fee: 3000,
          sqrtPriceLimitX96: 0n,
        }],
      });
      const quotedIn = Array.isArray(quote) ? BigInt(quote[0] as bigint) : BigInt(quote as bigint);
      if (quotedIn <= 0n) {
        throw new Error('UniswapV3SwapExecutor: invalid quoted amountIn for SELL');
      }
      const amountInMaximum = quotedIn + (quotedIn * BigInt(this.slippageBps) / 10_000n);

      await walletClient.writeContract({
        address: tokenIn as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [UNISWAP_V3_ROUTER as `0x${string}`, amountInMaximum],
      });

      txHash = await walletClient.writeContract({
        address: UNISWAP_V3_ROUTER as `0x${string}`,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactOutputSingle',
        args: [{
          tokenIn: tokenIn as `0x${string}`,
          tokenOut: tokenOut as `0x${string}`,
          fee: 3000,
          recipient: account.address,
          amountOut,
          amountInMaximum,
          sqrtPriceLimitX96: 0n,
        }],
      });
    }

    const receipt: SwapReceipt = {
      txHash,
      fromToken: tokenInSymbol,
      toToken: tokenOutSymbol,
      fromAmount: decision.finalAmountUsd,
      toAmount: decision.finalAmountUsd,
      gasPaidUsd: 0,
      timestamp: new Date().toISOString(),
      chain: 'bnb',
    };

    logTrade(this.config.tradesLogPath, signal.strategyId, signal.action as 'BUY' | 'SELL', signal.token, decision, receipt, false);
    logger.info('[UNISWAP_V3] Swap submitted', { txHash, from: tokenInSymbol, to: tokenOutSymbol });
    return receipt;
  }

  private resolveAmountOutMinimum(): bigint {
    if (this.configuredMinOut !== null) {
      return this.configuredMinOut;
    }
    if (this.allowUnsafeZeroMinOut) {
      logger.warn('UniswapV3SwapExecutor running with unsafe amountOutMinimum=0');
      return 0n;
    }
    throw new Error(
      'UniswapV3SwapExecutor: amountOutMinimum is required for safety. '
      + 'Set config.options.amountOutMinimum, or explicitly set allowUnsafeZeroMinOut=true for non-production only.'
    );
  }
}
