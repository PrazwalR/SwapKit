import type { SwapIntent, QuoteResult, SwapResult } from "./types.js";
import { normalizeIntent } from "./intent/parser.js";
import { QuoteEngine } from "./quote/engine.js";
import { MEVGuard } from "./mev/guard.js";
import { UniswapV4Adapter } from "./adapters/uniswap-v4.js";
import { OneInchFusionAdapter } from "./adapters/one-inch.js";
import { ParaswapAdapter } from "./adapters/paraswap.js";
import type { WalletClient, PublicClient } from "viem";

export interface SwapKitConfig {
  /** 1inch API key from developer.1inch.io */
  oneInchApiKey: string;
  /** URL of swap-kit-rs Rust engine. Optional — MEV simulation disabled if absent */
  rustEngineUrl?: string;
}

export class SwapKit {
  private quoteEngine: QuoteEngine;
  private mevGuard:    MEVGuard;

  constructor(config: SwapKitConfig) {
    this.quoteEngine = new QuoteEngine([
      new UniswapV4Adapter(),
      new OneInchFusionAdapter(config.oneInchApiKey),
      new ParaswapAdapter(),
    ]);

    this.mevGuard = new MEVGuard({
      engineUrl: config.rustEngineUrl,
      failOpen:  true,
    });
  }

  /** Get all quotes, sorted by best net output. */
  async quote(raw: SwapIntent): Promise<QuoteResult[]> {
    const intent = normalizeIntent(raw);
    const quotes = await this.quoteEngine.getQuotes(intent);

    if (!intent.skipMEVCheck) {
      // Apply MEV estimates to all quotes
      const reports = await Promise.all(
        quotes.map(q => this.mevGuard.simulate(intent, q))
      );
      return quotes.map((q, i) => this.mevGuard.applyMEVToQuote(q, reports[i]));
    }

    return quotes;
  }

  /** Execute the best quote. */
  async swap(
    raw: SwapIntent,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const quotes = await this.quote(raw);
    const best = quotes[0];

    const intent = normalizeIntent(raw);

    // Update recipient from wallet if not set
    if (best.routeData && intent.recipient === "0x0000000000000000000000000000000000000000") {
      intent.recipient = walletClient.account!.address;
    }

    // Get the right adapter
    const adapter = this.getAdapter(best.protocol);
    return adapter.execute(best, walletClient, publicClient);
  }

  private getAdapter(protocol: string) {
    // Access internal adapters by protocol name
    const adapters: Record<string, any> = {
      "uniswap-v4": new UniswapV4Adapter(),
      "1inch-fusion": new OneInchFusionAdapter(""), // Will be replaced with actual key
      "paraswap": new ParaswapAdapter()
    };
    return adapters[protocol];
  }
}

// Re-export everything developers need
export type {
  SwapIntent,
  QuoteResult,
  SwapResult,
  MEVReport,
  PoolKey,
  SwapProtocol,
} from "./types.js";

export { normalizeIntent } from "./intent/parser.js";
export { SwapIntentSchema } from "./intent/schema.js";
