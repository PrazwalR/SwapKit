/**
 * Slippage calculation and protection utilities.
 * Helps users set optimal slippage tolerance based on trade conditions.
 */

/**
 * Calculate minimum output amount given slippage tolerance.
 *
 * @param amountOut Expected output amount from quote
 * @param slippageBps Slippage tolerance in basis points (1 bps = 0.01%)
 * @returns Minimum acceptable output amount
 *
 * @example
 * calculateMinOutput(1000000n, 50) // 995000n (0.5% slippage)
 */
export function calculateMinOutput(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10000) {
    throw new Error(`Slippage must be 0-10000 bps, got ${slippageBps}`);
  }
  return amountOut * BigInt(10000 - slippageBps) / 10000n;
}

/**
 * Estimate optimal slippage based on pool liquidity and trade size.
 * Higher trade-to-liquidity ratio requires higher slippage tolerance.
 *
 * @param tradeSize Trade size in wei
 * @param poolLiquidity Total pool liquidity in wei
 * @returns Recommended slippage in basis points
 */
export function estimateOptimalSlippage(
  tradeSize: bigint,
  poolLiquidity: bigint
): number {
  if (poolLiquidity === 0n) return 200; // 2% for unknown liquidity

  // Trade as percentage of pool
  const tradePercent = Number(tradeSize * 10000n / poolLiquidity);

  if (tradePercent < 10) {
    // < 0.1% of pool — minimal slippage needed
    return 10; // 0.1%
  } else if (tradePercent < 100) {
    // 0.1% - 1% of pool — moderate slippage
    return 30; // 0.3%
  } else if (tradePercent < 500) {
    // 1% - 5% of pool — significant slippage
    return 100; // 1%
  } else {
    // > 5% of pool — high slippage, warn user
    return 200; // 2%
  }
}

/**
 * Checks if the given slippage is safe for the current pool conditions.
 * High slippage tolerance makes swaps more vulnerable to sandwich attacks.
 *
 * @param slippageBps Current slippage setting
 * @param poolDepthWei Total liquidity depth in the pool
 * @param tradeSizeWei Size of the trade
 * @returns Safety assessment
 */
export function assessSlippageSafety(
  slippageBps: number,
  poolDepthWei: bigint,
  tradeSizeWei: bigint
): {
  safe: boolean;
  recommendation: string;
  suggestedBps: number;
} {
  const optimal = estimateOptimalSlippage(tradeSizeWei, poolDepthWei);

  if (slippageBps <= optimal + 20) {
    return {
      safe: true,
      recommendation: "Slippage tolerance is appropriate for this trade.",
      suggestedBps: slippageBps,
    };
  }

  if (slippageBps > 200) {
    return {
      safe: false,
      recommendation: `Slippage of ${slippageBps / 100}% is dangerously high. You may lose significant value to MEV bots. Recommended: ${optimal / 100}%.`,
      suggestedBps: optimal,
    };
  }

  return {
    safe: true,
    recommendation: `Slippage of ${slippageBps / 100}% is higher than optimal (${optimal / 100}%) but acceptable.`,
    suggestedBps: optimal,
  };
}

/**
 * Calculate price impact in basis points.
 *
 * @param inputAmount Amount being sold
 * @param outputAmount Amount being received
 * @param spotPrice The current spot price (output per input, in same-denomination bigints)
 * @returns Price impact in basis points (positive = unfavorable)
 */
export function calculatePriceImpact(
  inputAmount: bigint,
  outputAmount: bigint,
  spotPrice: bigint
): number {
  if (spotPrice === 0n || inputAmount === 0n) return 0;

  // Expected output at spot price
  const expectedOutput = inputAmount * spotPrice / (10n ** 18n);
  if (expectedOutput === 0n) return 0;

  // Impact = (expected - actual) / expected * 10000
  const impact = Number((expectedOutput - outputAmount) * 10000n / expectedOutput);
  return Math.max(0, impact);
}
