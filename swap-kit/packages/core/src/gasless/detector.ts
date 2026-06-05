import type { WalletClient, PublicClient } from "viem";
import type { QuoteResult } from "../types.js";

// ─── Gas Affordability Check ─────────────────────────────────────────────────

/**
 * Result of a gas affordability check.
 * Used by the ExecutionEngine to decide whether to attempt gasless execution.
 */
export interface GasCheck {
  /** Whether the user has enough native token to cover estimated gas */
  canAffordGas: boolean;
  /** User's current native token balance in wei */
  userBalanceWei: bigint;
  /** Estimated gas cost for this swap in wei */
  estimatedGasCostWei: bigint;
  /** How much native token the user is short by (0n if they can afford it) */
  shortfallWei: bigint;
}

/**
 * Safety margin multiplier for gas estimation.
 * Gas prices can spike between quote and execution, so we add 20%
 * headroom to avoid failed transactions due to insufficient gas.
 */
const GAS_SAFETY_MARGIN_BPS = 12000n; // 120% (= 1.2x) in basis points
const BPS_DENOMINATOR = 10000n;

/**
 * Checks whether the user's wallet has enough native token (ETH, MATIC, etc.)
 * to cover the estimated gas cost of a swap.
 *
 * @param walletClient - The user's wallet (must have `.account` set)
 * @param publicClient - A public client connected to the target chain
 * @param quote        - The quote containing the estimated gas cost
 * @returns A `GasCheck` object describing the user's gas affordability
 *
 * @example
 * ```ts
 * const check = await checkGasAffordability(wallet, public, quote);
 * if (!check.canAffordGas) {
 *   console.log(`User is short by ${check.shortfallWei} wei`);
 * }
 * ```
 */
export async function checkGasAffordability(
  walletClient: WalletClient,
  publicClient: PublicClient,
  quote: QuoteResult,
): Promise<GasCheck> {
  const account = walletClient.account;
  if (!account) {
    // No account attached — cannot check balance, assume they can't afford gas
    return {
      canAffordGas: false,
      userBalanceWei: 0n,
      estimatedGasCostWei: quote.gasCostWei,
      shortfallWei: quote.gasCostWei,
    };
  }

  // Fetch the user's native token balance
  const userBalanceWei = await publicClient.getBalance({
    address: account.address,
  });

  // Apply 20% safety margin to the estimated gas cost
  const estimatedGasCostWithMargin =
    (quote.gasCostWei * GAS_SAFETY_MARGIN_BPS) / BPS_DENOMINATOR;

  const canAffordGas = userBalanceWei >= estimatedGasCostWithMargin;
  const shortfallWei = canAffordGas
    ? 0n
    : estimatedGasCostWithMargin - userBalanceWei;

  return {
    canAffordGas,
    userBalanceWei,
    estimatedGasCostWei: estimatedGasCostWithMargin,
    shortfallWei,
  };
}
