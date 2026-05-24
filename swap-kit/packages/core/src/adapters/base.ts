import type { SwapIntent, QuoteResult, SwapResult } from "../types.js";
import type { WalletClient, PublicClient } from "viem";

export interface ISwapAdapter {
  readonly protocol: string;

  /**
   * Returns a quote for the given intent.
   * Must resolve or reject within 5 seconds.
   * Must NOT execute any transaction.
   */
  quote(intent: Required<SwapIntent>): Promise<QuoteResult>;

  /**
   * Executes the swap described by the quote.
   * Called only after MEV check and user confirmation.
   */
  execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult>;

  /**
   * Returns true if this adapter can handle the given intent.
   * (e.g. 1inch Fusion+ requires specific chain support)
   */
  supports(intent: Required<SwapIntent>): boolean;
}
