import { useCallback, useState } from "react";
import { useWalletClient, usePublicClient } from "wagmi";
import type { SwapIntent, QuoteResult } from "@swap-kit/core";
import type { Hex } from "viem";
import { useSwapKit } from "../context/SwapKitProvider.js";

/** Possible states of the swap state machine. */
export type SwapStatus =
  | "idle"
  | "quoting"
  | "approving"
  | "swapping"
  | "success"
  | "error";

export interface UseSwapReturn {
  /** Current state-machine status. */
  status: SwapStatus;
  /** Quotes fetched during the `quoting` phase. */
  quotes: QuoteResult[] | undefined;
  /** Best quote (first element after sorting). */
  bestQuote: QuoteResult | undefined;
  /** Transaction hash once the swap is submitted. */
  txHash: Hex | undefined;
  /** Error encountered during any phase, or `undefined`. */
  error: Error | undefined;
  /** Kick off the full swap flow: quote → approve → swap. */
  swap: (intent: SwapIntent) => Promise<void>;
  /** Reset the hook back to idle state. */
  reset: () => void;
}

/**
 * Full swap state machine hook.
 *
 * Transitions: idle → quoting → approving → swapping → success
 *                                                    ↘ error
 *
 * Uses wagmi's `useWalletClient` / `usePublicClient` for chain interaction
 * and the `SwapKit` instance from context for quote & execution.
 *
 * @example
 * ```tsx
 * const { status, bestQuote, txHash, error, swap, reset } = useSwap();
 * // …
 * <button onClick={() => swap(intent)} disabled={status !== "idle"}>Swap</button>
 * ```
 */
export function useSwap(): UseSwapReturn {
  const swapKit = useSwapKit();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [status, setStatus] = useState<SwapStatus>("idle");
  const [quotes, setQuotes] = useState<QuoteResult[] | undefined>(undefined);
  const [txHash, setTxHash] = useState<Hex | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);

  const reset = useCallback(() => {
    setStatus("idle");
    setQuotes(undefined);
    setTxHash(undefined);
    setError(undefined);
  }, []);

  const swap = useCallback(
    async (intent: SwapIntent) => {
      if (!walletClient) {
        setError(new Error("Wallet not connected. Please connect your wallet first."));
        setStatus("error");
        return;
      }

      if (!publicClient) {
        setError(new Error("Public client unavailable. Check your wagmi provider config."));
        setStatus("error");
        return;
      }

      try {
        // ── 1. Quote ──────────────────────────────────────────────────
        setStatus("quoting");
        setError(undefined);

        const fetchedQuotes = await swapKit.quote(intent);
        setQuotes(fetchedQuotes);

        if (fetchedQuotes.length === 0) {
          throw new Error("No quotes available for this swap.");
        }

        // ── 2. Approve (placeholder — real approval logic lives in core) ──
        setStatus("approving");

        // ── 3. Swap ───────────────────────────────────────────────────
        setStatus("swapping");

        const result = await swapKit.swap(intent, walletClient, publicClient);
        setTxHash(result.txHash);
        setStatus("success");
      } catch (err) {
        const wrapped =
          err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        setStatus("error");
      }
    },
    [swapKit, walletClient, publicClient],
  );

  const bestQuote = quotes?.[0];

  return { status, quotes, bestQuote, txHash, error, swap, reset };
}
