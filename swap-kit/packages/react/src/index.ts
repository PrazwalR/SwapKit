// ─── Context & Provider ───────────────────────────────────────────────────────
export { SwapKitProvider, useSwapKit } from "./context/SwapKitProvider.js";
export type { SwapKitProviderProps } from "./context/SwapKitProvider.js";

// ─── Hooks ────────────────────────────────────────────────────────────────────
export { useQuote } from "./hooks/useQuote.js";
export type { UseQuoteResult, UseQuoteOptions } from "./hooks/useQuote.js";

export { useSwap } from "./hooks/useSwap.js";
export type { UseSwapResult, SwapStatus } from "./hooks/useSwap.js";

export { useMEVRisk } from "./hooks/useMEVRisk.js";
export type { UseMEVRiskResult, UseMEVRiskOptions } from "./hooks/useMEVRisk.js";

// ─── Re-exported types from core (convenience) ───────────────────────────────
export type {
  SwapIntent,
  QuoteResult,
  SwapResult,
  MEVReport,
  SwapProtocol,
  SwapKitConfig,
} from "@swap-kit/core";
