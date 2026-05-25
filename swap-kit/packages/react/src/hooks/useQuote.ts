"use client";

import { useQuery } from "@tanstack/react-query";
import type { SwapIntent, QuoteResult } from "@swap-kit/core";
import { useSwapKit } from "../context/SwapKitProvider.js";

export interface UseQuoteOptions {
  /** Auto-refresh interval in ms. Default: 15000 (15s). Set 0 to disable. */
  refetchInterval?: number;
  /** Whether the query is enabled. Default: true when intent is defined. */
  enabled?: boolean;
}

export interface UseQuoteResult {
  /** Array of quotes sorted by best net output */
  quotes: QuoteResult[] | undefined;
  /** The best quote (first in sorted array) */
  bestQuote: QuoteResult | undefined;
  /** Whether quotes are currently being fetched */
  isLoading: boolean;
  /** Whether initial data has been fetched */
  isFetched: boolean;
  /** Whether a background refetch is in progress */
  isRefetching: boolean;
  /** Error from the last fetch attempt */
  error: Error | null;
  /** Manually trigger a refetch */
  refetch: () => void;
}

/**
 * Fetches and caches swap quotes for a given intent.
 * Auto-refreshes every 15 seconds by default.
 *
 * @example
 * ```tsx
 * const { bestQuote, isLoading } = useQuote({
 *   fromToken: "ETH",
 *   toToken: "USDC",
 *   fromAmount: 1000000000000000000n,
 *   fromChainId: 1,
 * });
 * ```
 */
export function useQuote(
  intent: SwapIntent | undefined,
  options: UseQuoteOptions = {}
): UseQuoteResult {
  const sdk = useSwapKit();
  const { refetchInterval = 15000, enabled } = options;

  const isEnabled = enabled ?? (intent !== undefined);

  const query = useQuery({
    queryKey: ["swap-kit", "quote", intent ? serializeIntent(intent) : null],
    queryFn: async () => {
      if (!intent) throw new Error("No intent provided");
      return sdk.quote(intent);
    },
    enabled: isEnabled,
    refetchInterval: refetchInterval > 0 ? refetchInterval : false,
    staleTime: 10_000,       // Consider data fresh for 10s
    gcTime: 30_000,          // Keep in cache for 30s
    retry: 2,                // Retry failed quotes twice
    retryDelay: 1000,        // 1s between retries
  });

  return {
    quotes:       query.data,
    bestQuote:    query.data?.[0],
    isLoading:    query.isLoading,
    isFetched:    query.isFetched,
    isRefetching: query.isRefetching,
    error:        query.error,
    refetch:      () => { query.refetch(); },
  };
}

/**
 * Serializes a SwapIntent into a stable string for use as a query key.
 * Handles bigint serialization since JSON.stringify can't handle bigints.
 */
function serializeIntent(intent: SwapIntent): string {
  return JSON.stringify(intent, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
}
