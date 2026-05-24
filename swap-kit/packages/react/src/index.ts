// ─── Context / Provider ──────────────────────────────────────────────────────
export { SwapKitProvider, useSwapKit } from "./context/SwapKitProvider.js";
export type { SwapKitProviderProps } from "./context/SwapKitProvider.js";

// ─── Hooks ───────────────────────────────────────────────────────────────────
export { useQuote } from "./hooks/useQuote.js";
export { useSwap } from "./hooks/useSwap.js";
export type { SwapStatus, UseSwapReturn } from "./hooks/useSwap.js";
export { useMEVRisk } from "./hooks/useMEVRisk.js";

// ─── Re-exported core types for convenience ──────────────────────────────────
export type {
  SwapKitConfig,
  SwapIntent,
  QuoteResult,
  SwapResult,
  MEVReport,
  SwapProtocol,
  PoolKey,
} from "@swap-kit/core";

export { SwapKit, MEVGuard, normalizeIntent, SwapIntentSchema } from "@swap-kit/core";
