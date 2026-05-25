"use client";

import { useCallback, useState } from "react";
import { useWalletClient, usePublicClient } from "wagmi";
import type { SwapIntent, QuoteResult, SwapResult } from "@swap-kit/core";
import { useSwapKit } from "../context/SwapKitProvider.js";
import { useQuote, type UseQuoteOptions } from "./useQuote.js";

// ─── State Machine ────────────────────────────────────────────────────────────

export type SwapStatus =
  | "idle"       // No swap in progress
  | "quoting"    // Fetching quotes
  | "approving"  // Waiting for token approval tx
  | "swapping"   // Swap tx submitted, waiting for confirmation
  | "success"    // Swap completed successfully
  | "error";     // Swap failed

export interface UseSwapResult {
  /** Current state of the swap process */
  status: SwapStatus;
  /** All fetched quotes (auto-refreshing) */
  quotes: QuoteResult[] | undefined;
  /** The best available quote */
  bestQuote: QuoteResult | undefined;
  /** Whether quotes are loading */
  isQuoting: boolean;
  /** Transaction hash once submitted */
  txHash: string | undefined;
  /** Full swap result on success */
  result: SwapResult | undefined;
  /** Error details if status is "error" */
  error: Error | null;
  /** Execute the swap with the best available quote */
  swap: () => Promise<void>;
  /** Reset the state machine back to idle */
  reset: () => void;
}

/**
 * Full swap lifecycle hook with state machine.
 * Handles quoting, approval, execution, and error states.
 *
 * @example
 * ```tsx
 * const { bestQuote, status, swap, error, txHash } = useSwap({
 *   fromToken: "ETH",
 *   toToken: "USDC",
 *   fromAmount: parseEther("1"),
 *   fromChainId: 1,
 * });
 *
 * return (
 *   <button onClick={swap} disabled={status !== "idle" || !bestQuote}>
 *     {status === "swapping" ? "Swapping..." : `Swap for ${bestQuote?.amountOut}`}
 *   </button>
 * );
 * ```
 */
export function useSwap(
  intent: SwapIntent | undefined,
  quoteOptions?: UseQuoteOptions
): UseSwapResult {
  const sdk = useSwapKit();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [status, setStatus] = useState<SwapStatus>("idle");
  const [txHash, setTxHash] = useState<string | undefined>();
  const [result, setResult] = useState<SwapResult | undefined>();
  const [error, setError] = useState<Error | null>(null);

  // Auto-refreshing quotes
  const {
    quotes,
    bestQuote,
    isLoading: isQuoting,
  } = useQuote(intent, {
    ...quoteOptions,
    // Pause quote refreshing during swap execution
    enabled: intent !== undefined && status === "idle",
  });

  const swap = useCallback(async () => {
    if (!intent || !walletClient || !publicClient) {
      setError(new Error("Wallet not connected or intent not provided"));
      setStatus("error");
      return;
    }

    try {
      setStatus("approving");
      setError(null);
      setTxHash(undefined);
      setResult(undefined);

      setStatus("swapping");

      const swapResult = await sdk.swap(intent, walletClient, publicClient);

      setTxHash(swapResult.txHash);
      setResult(swapResult);
      setStatus("success");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      setStatus("error");
    }
  }, [intent, walletClient, publicClient, sdk]);

  const reset = useCallback(() => {
    setStatus("idle");
    setTxHash(undefined);
    setResult(undefined);
    setError(null);
  }, []);

  return {
    status,
    quotes,
    bestQuote,
    isQuoting,
    txHash,
    result,
    error,
    swap,
    reset,
  };
}
