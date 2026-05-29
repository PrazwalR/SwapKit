import type { SwapIntent, QuoteResult, SwapProtocol } from "../types.js";
import type { ISwapAdapter } from "../adapters/base.js";

export interface QuoteEngineConfig {
  /** Timeout per adapter in ms. Default: 5000 */
  timeoutMs?: number;
  /** Minimum number of successful quotes before returning. Default: 1 */
  minQuotes?: number;
}

export class QuoteEngine {
  private adapters: Map<SwapProtocol, ISwapAdapter>;

  constructor(adapters: ISwapAdapter[]) {
    this.adapters = new Map(adapters.map(a => [a.protocol as SwapProtocol, a]));
  }

  /**
   * Fans out to all applicable adapters in parallel.
   * Returns all successful quotes sorted by netAmountOut (descending).
   * Failed adapters are logged but don't throw.
   */
  async getQuotes(
    intent: Required<SwapIntent>,
    config: QuoteEngineConfig = {}
  ): Promise<QuoteResult[]> {
    const { timeoutMs = 15000 } = config;

    const applicable = intent.protocols.filter(p => {
      const adapter = this.adapters.get(p);
      return adapter?.supports(intent) ?? false;
    });

    if (applicable.length === 0) {
      throw new Error(`No adapters support this intent: ${JSON.stringify({
        fromChain: intent.fromChainId,
        toChain:   intent.toChainId,
      })}`);
    }

    const results = await Promise.allSettled(
      applicable.map(protocol => {
        const adapter = this.adapters.get(protocol)!;
        return Promise.race([
          adapter.quote(intent),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${protocol} quote timed out after ${timeoutMs}ms`)), timeoutMs)
          ),
        ]);
      })
    );

    const quotes: QuoteResult[] = [];
    for (const [i, result] of results.entries()) {
      if (result.status === "fulfilled") {
        quotes.push(result.value);
      } else {
        console.warn(`[swap-kit] ${applicable[i]} quote failed:`, result.reason);
      }
    }

    if (quotes.length === 0) {
      throw new Error("All adapters failed to return quotes");
    }

    // Sort by netAmountOut descending — user gets the most tokens
    return quotes.sort((a, b) => (b.netAmountOut > a.netAmountOut ? 1 : -1));
  }

  getBestQuote(quotes: QuoteResult[]): QuoteResult {
    return quotes[0]; // Already sorted
  }
}
