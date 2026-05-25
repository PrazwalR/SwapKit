"use client";

import { useQuery } from "@tanstack/react-query";
import { MEVGuard, type QuoteResult, type MEVReport, type SwapIntent } from "@swap-kit/core";

export interface UseMEVRiskOptions {
  /** MEV engine URL. Default: http://localhost:3030 */
  engineUrl?: string;
  /** Stale time in ms. Default: 30000 (30s) */
  staleTime?: number;
}

export interface UseMEVRiskResult {
  /** MEV risk report */
  report: MEVReport | undefined;
  /** Whether the simulation is in progress */
  isLoading: boolean;
  /** Error from simulation */
  error: Error | null;
}

/**
 * Monitors MEV risk for a given quote in real-time.
 * Calls the Rust MEV simulation engine to detect sandwich attack exposure.
 *
 * @example
 * ```tsx
 * const { report } = useMEVRisk(bestQuote, intent);
 *
 * if (report?.sandwichRisk === "high") {
 *   return <Warning>High MEV risk detected!</Warning>;
 * }
 * ```
 */
export function useMEVRisk(
  quote: QuoteResult | undefined,
  intent: Required<SwapIntent> | undefined,
  options: UseMEVRiskOptions = {}
): UseMEVRiskResult {
  const { engineUrl, staleTime = 30_000 } = options;

  const guard = new MEVGuard({
    engineUrl,
    failOpen: true,
  });

  const query = useQuery({
    queryKey: [
      "swap-kit",
      "mev-risk",
      quote?.protocol,
      quote?.amountOut?.toString(),
      intent?.fromToken,
      intent?.toToken,
    ],
    queryFn: async () => {
      if (!quote || !intent) throw new Error("No quote or intent provided");
      return guard.simulate(intent, quote);
    },
    enabled: quote !== undefined && intent !== undefined,
    staleTime,
    gcTime: 60_000,
    retry: 1,
  });

  return {
    report:    query.data,
    isLoading: query.isLoading,
    error:     query.error,
  };
}
