import { useQuery } from "@tanstack/react-query";
import { MEVGuard, type QuoteResult, type MEVReport, type SwapIntent } from "@swap-kit/core";

/** Stale time for MEV reports — mempool conditions change quickly. */
const MEV_STALE_TIME = 30_000;

/**
 * Simulates MEV risk for a given quote.
 *
 * Creates an `MEVGuard` instance internally (fail-open by default) and
 * calls `simulate()`. Results are cached for 30 s via `@tanstack/react-query`.
 *
 * Returns `undefined` data when either `intent` or `quote` is `undefined`.
 *
 * @example
 * ```ts
 * const { data: mevReport, isLoading } = useMEVRisk(intent, bestQuote);
 * if (mevReport?.sandwichRisk === "high") showWarning();
 * ```
 */
export function useMEVRisk(
  intent: SwapIntent | undefined,
  quote: QuoteResult | undefined,
) {
  return useQuery<MEVReport, Error>({
    queryKey: ["swap-kit", "mev-risk", intent, quote?.protocol, quote?.amountOut?.toString()],
    queryFn: async () => {
      if (!intent || !quote) {
        throw new Error("Intent and quote are required for MEV simulation");
      }

      const guard = new MEVGuard({ failOpen: true });

      // MEVGuard.simulate expects Required<SwapIntent>. We cast here — the
      // guard itself is fail-open so missing optional fields won't crash.
      return guard.simulate(intent as Required<SwapIntent>, quote);
    },
    enabled: !!intent && !!quote,
    staleTime: MEV_STALE_TIME,
  });
}
