import { createContext, useContext, useMemo, type ReactNode } from "react";
import { SwapKit, type SwapKitConfig } from "@swap-kit/core";

/**
 * Internal context that holds the SwapKit SDK instance.
 * Consumers access it via the `useSwapKit()` hook.
 */
const SwapKitContext = createContext<SwapKit | null>(null);

export interface SwapKitProviderProps {
  /** Configuration forwarded to the SwapKit constructor. */
  config: SwapKitConfig;
  children: ReactNode;
}

/**
 * Provides a shared `SwapKit` instance to the React tree.
 *
 * ```tsx
 * <SwapKitProvider config={{ oneInchApiKey: "…" }}>
 *   <App />
 * </SwapKitProvider>
 * ```
 */
export function SwapKitProvider({ config, children }: SwapKitProviderProps) {
  const swapKit = useMemo(
    () => new SwapKit(config),
    // Re-create instance only when the config identity changes.
    // Consumers should pass a stable config object or memoise it.
    [config],
  );

  return (
    <SwapKitContext.Provider value={swapKit}>
      {children}
    </SwapKitContext.Provider>
  );
}

/**
 * Returns the `SwapKit` instance provided by the nearest `<SwapKitProvider>`.
 *
 * @throws if called outside a `<SwapKitProvider>`.
 */
export function useSwapKit(): SwapKit {
  const ctx = useContext(SwapKitContext);
  if (!ctx) {
    throw new Error(
      "useSwapKit() must be used within a <SwapKitProvider>. " +
        "Wrap your component tree with <SwapKitProvider config={…}>.",
    );
  }
  return ctx;
}
