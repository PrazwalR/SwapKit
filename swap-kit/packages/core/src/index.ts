import type { SwapIntent, QuoteResult, SwapResult, SwapProtocol } from "./types.js";
import { normalizeIntent } from "./intent/parser.js";
import { QuoteEngine } from "./quote/engine.js";
import { MEVGuard } from "./mev/guard.js";
import { ExecutionEngine } from "./execution/engine.js";
import { UniswapV4Adapter } from "./adapters/uniswap-v4.js";
import { OneInchFusionAdapter } from "./adapters/one-inch.js";
import { ParaswapAdapter } from "./adapters/paraswap.js";
import type { ISwapAdapter } from "./adapters/base.js";
import type { WalletClient, PublicClient } from "viem";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface SwapKitConfig {
  /** 1inch API key from developer.1inch.io */
  oneInchApiKey: string;
  /** URL of swap-kit-rs Rust engine. Optional — MEV simulation disabled if absent */
  rustEngineUrl?: string;
  /** Fail silently if MEV engine is unreachable. Default: true */
  mevFailOpen?: boolean;
}

// ─── Main SDK Class ───────────────────────────────────────────────────────────

export class SwapKit {
  private adapters: ISwapAdapter[];
  private quoteEngine: QuoteEngine;
  private executionEngine: ExecutionEngine;
  private mevGuard: MEVGuard;

  constructor(config: SwapKitConfig) {
    this.adapters = [
      new UniswapV4Adapter(),
      new OneInchFusionAdapter(config.oneInchApiKey),
      new ParaswapAdapter(),
    ];

    this.quoteEngine = new QuoteEngine(this.adapters);

    this.executionEngine = new ExecutionEngine(this.adapters);

    this.mevGuard = new MEVGuard({
      engineUrl: config.rustEngineUrl,
      failOpen:  config.mevFailOpen ?? true,
    });
  }

  /**
   * Get all quotes for a swap intent, sorted by best net output.
   * Automatically applies MEV estimates unless skipMEVCheck is set.
   */
  async quote(raw: SwapIntent): Promise<QuoteResult[]> {
    const intent = normalizeIntent(raw);
    const quotes = await this.quoteEngine.getQuotes(intent);

    if (!intent.skipMEVCheck) {
      // Apply MEV estimates to all quotes in parallel
      const reports = await Promise.all(
        quotes.map(q => this.mevGuard.simulate(intent, q))
      );
      return quotes.map((q, i) => this.mevGuard.applyMEVToQuote(q, reports[i]));
    }

    return quotes;
  }

  /**
   * Execute the best swap for a given intent.
   * Handles quoting, MEV checking, approvals, and transaction submission.
   */
  async swap(
    raw: SwapIntent,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const quotes = await this.quote(raw);
    const best = quotes[0];

    if (!best) {
      throw new Error("No valid quotes returned for this swap intent");
    }

    const intent = normalizeIntent(raw);

    // Update recipient from wallet if not set
    if (intent.recipient === "0x0000000000000000000000000000000000000000") {
      intent.recipient = walletClient.account!.address;
    }

    return this.executionEngine.execute(intent, best, walletClient, publicClient);
  }

  /**
   * Get the best single quote for a swap intent.
   */
  async bestQuote(raw: SwapIntent): Promise<QuoteResult> {
    const quotes = await this.quote(raw);
    if (quotes.length === 0) {
      throw new Error("No valid quotes returned");
    }
    return quotes[0];
  }

  /**
   * Access the MEV guard for direct simulation.
   */
  getMEVGuard(): MEVGuard {
    return this.mevGuard;
  }

  /**
   * Access the quote engine for direct quote fetching.
   */
  getQuoteEngine(): QuoteEngine {
    return this.quoteEngine;
  }

  /**
   * Access the execution engine for direct execution.
   */
  getExecutionEngine(): ExecutionEngine {
    return this.executionEngine;
  }
}

// ─── Convenience Factory ──────────────────────────────────────────────────────

/**
 * Create a new SwapKit instance with the given config.
 *
 * @example
 * ```ts
 * const sdk = createSwapKit({
 *   oneInchApiKey: process.env.ONEINCH_API_KEY!,
 *   rustEngineUrl: "http://localhost:3030",
 * });
 *
 * const quotes = await sdk.quote({
 *   fromToken: "ETH",
 *   toToken: "USDC",
 *   fromAmount: 1000000000000000000n, // 1 ETH
 *   fromChainId: 1,
 * });
 * ```
 */
export function createSwapKit(config: SwapKitConfig): SwapKit {
  return new SwapKit(config);
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

// Types
export type {
  SwapIntent,
  QuoteResult,
  SwapResult,
  MEVReport,
  PoolKey,
  SwapProtocol,
  UniswapV4RouteData,
  OneInchRouteData,
  ParaswapRouteData,
  FusionOrderStruct,
} from "./types.js";

// Intent
export { normalizeIntent, resolveToken } from "./intent/parser.js";
export { SwapIntentSchema } from "./intent/schema.js";

// Engines
export { QuoteEngine } from "./quote/engine.js";
export type { QuoteEngineConfig } from "./quote/engine.js";
export { MEVGuard } from "./mev/guard.js";
export type { MEVGuardConfig } from "./mev/guard.js";
export { ExecutionEngine } from "./execution/engine.js";
export type { ExecutionEngineConfig } from "./execution/engine.js";

// Adapters
export type { ISwapAdapter } from "./adapters/base.js";
export { UniswapV4Adapter } from "./adapters/uniswap-v4.js";
export { OneInchFusionAdapter } from "./adapters/one-inch.js";
export { ParaswapAdapter } from "./adapters/paraswap.js";

// Utilities
export {
  isNativeToken,
  getTokenDecimals,
  getTokenSymbol,
  getTokenBalance,
  formatTokenAmount,
  parseTokenAmount,
} from "./utils/token.js";

export {
  getChainConfig,
  getSupportedChainIds,
  isChainSupported,
  getPublicClient,
  getTxExplorerUrl,
  getAddressExplorerUrl,
} from "./utils/chain.js";

export {
  calculateMinOutput,
  estimateOptimalSlippage,
  assessSlippageSafety,
  calculatePriceImpact,
} from "./mev/slippage.js";
