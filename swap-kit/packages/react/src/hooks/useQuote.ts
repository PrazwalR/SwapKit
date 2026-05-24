import { useQuery } from "@tanstack/react-query";
import type { SwapIntent, QuoteResult } from "@swap-kit/core";
import { useSwapKit } from "../context/SwapKitProvider.js";

/** Auto-refresh interval for quotes (15 seconds). */
const QUOTE_REFETCH_INTERVAL = 15_000;

/**
 * Fetches and caches swap quotes for a given intent.
 *
 * - Queries are cached by serialised intent via `@tanstack/react-query`.
 * - Auto-refreshes every 15 s while `intent` is defined.
 * - Returns `undefined` data when `intent` is `undefined` (disabled query).
 *
 * @example
 * ```ts
 * const { data: quotes, isLoading, error, refetch } = useQuote(intent);
 * ```
 */
export function useQuote(intent: SwapIntent | undefined) {
  const swapKit = useSwapKit();

  return useQuery<QuoteResult[], Error>({
    queryKey: ["swap-kit", "quote", intent],
    queryFn: () => {
      if (!intent) throw new Error("Intent is required");
      return swapKit.quote(intent);
    },
    enabled: !!intent,
    refetchInterval: QUOTE_REFETCH_INTERVAL,
    // Quotes become stale immediately — always refetch on window focus.
    staleTime: 0,
  });
}
