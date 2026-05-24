import type { QuoteResult, MEVReport, SwapIntent } from "../types.js";

export interface MEVGuardConfig {
  /** URL of the Rust MEV simulation engine. Default: http://localhost:3030 */
  engineUrl?: string;
  /** Skip simulation if engine is unreachable. Default: true */
  failOpen?: boolean;
}

export class MEVGuard {
  private config: Required<MEVGuardConfig>;

  constructor(config: MEVGuardConfig = {}) {
    this.config = {
      engineUrl: config.engineUrl ?? "http://localhost:3030",
      failOpen:  config.failOpen  ?? true,
    };
  }

  async simulate(
    intent: Required<SwapIntent>,
    quote: QuoteResult
  ): Promise<MEVReport> {
    try {
      const response = await fetch(`${this.config.engineUrl}/simulate`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_token:       intent.fromToken,
          to_token:         intent.toToken,
          from_amount:      intent.fromAmount.toString(),
          chain_id:         intent.fromChainId,
          protocol:         quote.protocol,
          amount_out:       quote.amountOut.toString(),
          slippage_bps:     intent.maxSlippageBps,
        }),
        signal: AbortSignal.timeout(2000), // 2s max — don't block the user
      });

      if (!response.ok) throw new Error(`MEV engine returned ${response.status}`);

      const raw = await response.json() as {
        sandwich_risk:           string;
        estimated_mev_wei:       string;
        recommended_slippage_bps: number;
        detected_bots:           string[];
      };

      return {
        sandwichRisk:           raw.sandwich_risk as MEVReport["sandwichRisk"],
        estimatedMEVWei:        BigInt(raw.estimated_mev_wei),
        recommendedSlippageBps: raw.recommended_slippage_bps,
        detectedBots:           raw.detected_bots as any[],
      };
    } catch (err) {
      if (this.config.failOpen) {
        console.warn("[swap-kit] MEV simulation unavailable, proceeding without it:", err);
        return {
          sandwichRisk:           "low",
          estimatedMEVWei:        0n,
          recommendedSlippageBps: intent.maxSlippageBps,
          detectedBots:           [],
        };
      }
      throw err;
    }
  }

  /**
   * Adjusts the quote's netAmountOut by subtracting estimated MEV.
   * This gives a realistic "what the user will actually receive" number.
   */
  applyMEVToQuote(quote: QuoteResult, report: MEVReport): QuoteResult {
    return {
      ...quote,
      mevExposure:  report.estimatedMEVWei,
      netAmountOut: quote.amountOut > report.estimatedMEVWei
        ? quote.amountOut - report.estimatedMEVWei
        : 0n,
    };
  }
}
