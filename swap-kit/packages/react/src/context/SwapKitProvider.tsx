"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { SwapKit, type SwapKitConfig } from "@swap-kit/core";

// ─── Context ──────────────────────────────────────────────────────────────────

const SwapKitContext = createContext<SwapKit | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export interface SwapKitProviderProps {
  /** SwapKit configuration (API keys, engine URL, etc.) */
  config: SwapKitConfig;
  children: ReactNode;
}

/**
 * Provides a SwapKit instance to all child components.
 * Wrap your app (or swap-related subtree) with this provider.
 *
 * @example
 * ```tsx
 * <SwapKitProvider config={{ oneInchApiKey: "your-key" }}>
 *   <SwapWidget />
 * </SwapKitProvider>
 * ```
 */
export function SwapKitProvider({ config, children }: SwapKitProviderProps) {
  const sdk = useMemo(() => new SwapKit(config), [
    config.oneInchApiKey,
    config.rustEngineUrl,
    config.mevFailOpen,
  ]);

  return (
    <SwapKitContext.Provider value={sdk}>
      {children}
    </SwapKitContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Access the SwapKit instance from context.
 * Must be used within a `<SwapKitProvider>`.
 *
 * @throws If used outside of SwapKitProvider
 */
export function useSwapKit(): SwapKit {
  const sdk = useContext(SwapKitContext);
  if (!sdk) {
    throw new Error(
      "useSwapKit must be used within a <SwapKitProvider>. " +
      "Wrap your component tree with <SwapKitProvider config={...}>."
    );
  }
  return sdk;
}
