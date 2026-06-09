//! Sandwich Attack Profitability Calculator
//!
//! Uses REAL gas prices and trade parameters to determine if a sandwich
//! attack is actually profitable. This replaces the old heuristic approach.
//!
//! # Key insight
//!
//! A sandwich attack requires TWO transactions (front-run + back-run),
//! each costing gas. The attacker's profit must exceed 2× gas cost.
//!
//! ```text
//! attacker_profit = extractable_value - (2 × gas_cost)
//! extractable_value = slippage_tolerance × amount_out × extraction_efficiency
//! gas_cost = gas_price × estimated_gas_units
//! ```
//!
//! If `attacker_profit > 0`, the sandwich is viable and the user is at risk.

/// Estimated gas units for a typical sandwich front-run/back-run swap.
/// A Uniswap V3/V4 swap costs ~150k gas. The attacker does two of these.
const SANDWICH_GAS_UNITS: u128 = 300_000; // 150k per leg × 2 legs

/// What fraction of the slippage tolerance a bot can realistically extract.
/// Research shows ~60-80% extraction efficiency. We use 70%.
const EXTRACTION_EFFICIENCY_BPS: u128 = 7000; // 70% in basis points
const BPS: u128 = 10000;

/// Result of the profitability analysis.
#[derive(Debug, Clone)]
pub struct ProfitabilityResult {
    /// Whether the sandwich attack is economically viable
    pub is_profitable: bool,
    /// Estimated profit the attacker would make (0 if not profitable)
    pub attacker_profit_wei: u128,
    /// Total extractable value from the user's slippage
    pub extractable_value_wei: u128,
    /// Total gas cost the attacker must pay for front-run + back-run
    pub attacker_gas_cost_wei: u128,
    /// Risk classification derived from profitability
    pub risk_level: &'static str,
    /// Optimal slippage recommendation to make attack unprofitable
    pub recommended_slippage_bps: u32,
}

/// Calculate whether a sandwich attack is profitable given real gas prices.
///
/// # Unit correctness
///
/// A profitability decision must compare two amounts in the SAME unit. The
/// attacker's gas cost is denominated in the chain's **native-token wei** (ETH on
/// mainnet, MATIC on Polygon, …). So the value the attacker can extract must also
/// be expressed in native-token wei — `eth_notional_wei`, the trade's notional in
/// the native token. Comparing an output-token amount (e.g. 6-decimal USDC) to
/// gas-in-wei is meaningless and previously made every stablecoin-output swap look
/// like "no risk" regardless of size.
///
/// `amount_out` (output-token units) is used ONLY to report `extractable_value_wei`
/// — the user's worst-case slippage loss in the token they receive — which the
/// TypeScript layer subtracts from `netAmountOut` (also output-token units).
///
/// If the trade cannot be priced in the native token (`eth_notional_wei` is `None`,
/// e.g. a token→token swap with no oracle), the risk is honestly reported as
/// `"unknown"` rather than guessed.
///
/// # Arguments
/// * `amount_out` — Expected output of the user's swap (output-token units)
/// * `eth_notional_wei` — Trade value in native-token wei, or `None` if unpriceable
/// * `slippage_bps` — User's slippage tolerance in basis points
/// * `gas_price_wei` — Current gas price from `eth_gasPrice` (in wei)
/// * `is_mainnet` — Whether this is Ethereum mainnet (higher bot activity)
pub fn calculate_sandwich_profitability(
    amount_out: u128,
    eth_notional_wei: Option<u128>,
    slippage_bps: u64,
    gas_price_wei: Option<u128>,
    is_mainnet: bool,
) -> ProfitabilityResult {
    // Reported extractable value, in OUTPUT-TOKEN units (for netAmountOut).
    // = amount_out × (slippage_bps / 10000) × extraction_efficiency
    let token_extractable = apply_slippage_and_efficiency(amount_out, slippage_bps);

    // Attacker's gas cost for the two sandwich transactions, in native-token wei.
    let gas_cost = match gas_price_wei {
        Some(gp) => SANDWICH_GAS_UNITS.checked_mul(gp).unwrap_or(u128::MAX),
        None => {
            // No real gas price — fall back to a conservative estimate.
            let default_gas = if is_mainnet { 30_000_000_000u128 } else { 1_000_000_000u128 };
            SANDWICH_GAS_UNITS.checked_mul(default_gas).unwrap_or(u128::MAX)
        }
    };

    // Without a native-token valuation we cannot honestly decide profitability.
    let eth_notional = match eth_notional_wei {
        Some(v) if v > 0 => v,
        _ => {
            return ProfitabilityResult {
                is_profitable: false,
                attacker_profit_wei: 0,
                extractable_value_wei: token_extractable,
                attacker_gas_cost_wei: gas_cost,
                risk_level: "unknown",
                // Conservative: never recommend looser than the user asked, cap at 50 bps.
                recommended_slippage_bps: (slippage_bps.min(50)).max(1) as u32,
            };
        }
    };

    // Value the attacker can extract, in native-token wei — same unit as gas_cost.
    let eth_extractable = apply_slippage_and_efficiency(eth_notional, slippage_bps);

    let is_profitable = eth_extractable > gas_cost;
    let attacker_profit = if is_profitable { eth_extractable - gas_cost } else { 0 };

    // Classify risk by how far profit exceeds the gas the attacker risks.
    //   high   = profit ≥ 5× gas cost (easy money)
    //   medium = profit 1–4× gas cost
    //   low    = profit > 0 but < 1× gas cost
    let risk_level = if !is_profitable {
        "none"
    } else {
        let profit_to_gas_ratio = if gas_cost > 0 { attacker_profit / gas_cost } else { u128::MAX };
        match profit_to_gas_ratio {
            5.. => "high",
            1..=4 => "medium",
            _ => "low",
        }
    };

    // Mainnet has more bot competition, so bump non-"none" risk up one notch.
    let risk_level = if is_mainnet && risk_level == "low" {
        "medium"
    } else if is_mainnet && risk_level == "medium" {
        "high"
    } else {
        risk_level
    };

    // Recommend a slippage that makes the attack unprofitable, in native-token terms:
    //   eth_notional × (slip/BPS) × eff ≤ gas_cost
    //   slip ≤ gas_cost × BPS × BPS / (eth_notional × eff)
    let recommended_slippage_bps = if slippage_bps > 0 {
        let numerator = gas_cost.checked_mul(BPS * BPS).unwrap_or(u128::MAX);
        let denominator = eth_notional.checked_mul(EXTRACTION_EFFICIENCY_BPS).unwrap_or(1);
        let optimal = (numerator / denominator).min(u32::MAX as u128) as u32;
        // Clamp between 1 bps (0.01%) and the user's original slippage.
        optimal.clamp(1, slippage_bps as u32)
    } else {
        0
    };

    ProfitabilityResult {
        is_profitable,
        attacker_profit_wei: attacker_profit,
        extractable_value_wei: token_extractable,
        attacker_gas_cost_wei: gas_cost,
        risk_level,
        recommended_slippage_bps,
    }
}

/// `value × (slippage_bps / 10000) × (EXTRACTION_EFFICIENCY_BPS / 10000)`, saturating.
fn apply_slippage_and_efficiency(value: u128, slippage_bps: u64) -> u128 {
    let after_slippage = value
        .checked_mul(slippage_bps as u128)
        .map(|v| v / BPS)
        .unwrap_or(value);
    after_slippage
        .checked_mul(EXTRACTION_EFFICIENCY_BPS)
        .map(|v| v / BPS)
        .unwrap_or(after_slippage)
}

#[cfg(test)]
mod tests {
    use super::*;

    // For ETH-output swaps the output token IS the native token, so amount_out and
    // eth_notional coincide. We pass both explicitly to exercise the new signature.
    #[test]
    fn test_large_trade_high_slippage_low_gas_is_profitable() {
        // 100 ETH notional, 200 bps slippage, 5 gwei gas
        let eth = 100_000_000_000_000_000_000u128; // 100 ETH
        let result = calculate_sandwich_profitability(
            eth,
            Some(eth),
            200,    // 2% slippage
            Some(5_000_000_000), // 5 gwei
            true,   // mainnet
        );
        assert!(result.is_profitable, "Large trade with high slippage and low gas should be profitable");
        assert_eq!(result.risk_level, "high");
        assert!(result.attacker_profit_wei > 0);
    }

    #[test]
    fn test_small_trade_tight_slippage_high_gas_not_profitable() {
        // 0.01 ETH notional, 10 bps slippage, 200 gwei gas
        let eth = 10_000_000_000_000_000u128; // 0.01 ETH
        let result = calculate_sandwich_profitability(
            eth,
            Some(eth),
            10,     // 0.1% slippage
            Some(200_000_000_000), // 200 gwei
            true,
        );
        assert!(!result.is_profitable, "Tiny trade with tight slippage and high gas should NOT be profitable");
        assert_eq!(result.risk_level, "none");
        assert_eq!(result.attacker_profit_wei, 0);
    }

    // THE BUG THIS FIX TARGETS: a huge stablecoin-output trade is a real sandwich
    // target, but its 6-decimal amount_out is tiny next to gas-in-wei. The risk must
    // come from the ETH notional, not from comparing USDC units to wei.
    #[test]
    fn test_large_stablecoin_output_trade_is_still_high_risk() {
        // 1000 ETH → ~1.6M USDC. amount_out is 1_600_000_000_000 (6 decimals).
        let amount_out_usdc = 1_600_000_000_000u128;
        let eth_notional = 1_000_000_000_000_000_000_000u128; // 1000 ETH
        let result = calculate_sandwich_profitability(
            amount_out_usdc,
            Some(eth_notional),
            200, // 2% slippage
            Some(20_000_000_000), // 20 gwei
            true,
        );
        assert!(result.is_profitable, "A $1.6M trade at 2% slippage must read as profitable");
        assert_eq!(result.risk_level, "high");
        // extractable is reported in USDC units (for netAmountOut), not wei.
        assert!(result.extractable_value_wei > 0);
    }

    // Token→token with no native valuation must be "unknown", never a confident "none".
    #[test]
    fn test_unpriceable_trade_is_unknown() {
        let result = calculate_sandwich_profitability(
            1_000_000_000u128, // some DAI out
            None,              // cannot price in native token
            200,
            Some(20_000_000_000),
            true,
        );
        assert_eq!(result.risk_level, "unknown");
        assert!(!result.is_profitable);
    }

    #[test]
    fn test_no_gas_price_uses_fallback() {
        let eth = 50_000_000_000_000_000_000u128; // 50 ETH
        let result = calculate_sandwich_profitability(
            eth,
            Some(eth),
            100,    // 1% slippage
            None,   // No RPC → fallback gas estimate
            true,
        );
        // Should still produce a valid result using default 30 gwei
        assert!(result.attacker_gas_cost_wei > 0);
    }

    #[test]
    fn test_zero_amount_out_is_safe() {
        let result = calculate_sandwich_profitability(0, Some(0), 200, Some(10_000_000_000), true);
        assert!(!result.is_profitable);
        // Zero notional cannot be valued → unknown rather than a false "none".
        assert_eq!(result.risk_level, "unknown");
    }

    #[test]
    fn test_zero_slippage_is_safe() {
        let eth = 100_000_000_000_000_000_000u128;
        let result = calculate_sandwich_profitability(eth, Some(eth), 0, Some(10_000_000_000), true);
        assert!(!result.is_profitable);
        assert_eq!(result.risk_level, "none");
    }

    #[test]
    fn test_l2_has_lower_risk_than_mainnet() {
        let eth = 10_000_000_000_000_000_000u128; // 10 ETH
        let mainnet = calculate_sandwich_profitability(eth, Some(eth), 100, Some(10_000_000_000), true);
        let l2 = calculate_sandwich_profitability(eth, Some(eth), 100, Some(10_000_000_000), false);

        // L2 risk should be same or lower than mainnet for identical parameters
        let risk_order = |r: &str| -> u8 {
            match r { "high" => 3, "medium" => 2, "low" => 1, _ => 0 }
        };
        assert!(risk_order(l2.risk_level) <= risk_order(mainnet.risk_level),
            "L2 risk ({}) should be <= mainnet risk ({})", l2.risk_level, mainnet.risk_level);
    }

    #[test]
    fn test_recommended_slippage_makes_attack_unprofitable() {
        let eth = 50_000_000_000_000_000_000u128; // 50 ETH
        let gas_price = 20_000_000_000u128; // 20 gwei
        let result = calculate_sandwich_profitability(eth, Some(eth), 200, Some(gas_price), true);

        if result.is_profitable {
            // Re-run with the recommended slippage — should be unprofitable
            let safer = calculate_sandwich_profitability(
                eth,
                Some(eth),
                result.recommended_slippage_bps as u64,
                Some(gas_price),
                true,
            );
            assert!(!safer.is_profitable || safer.risk_level == "none" || safer.risk_level == "low",
                "Recommended slippage should make attack unprofitable or low risk, got: {}", safer.risk_level);
        }
    }

    #[test]
    fn test_overflow_protection() {
        // u128::MAX amounts — should not panic
        let result = calculate_sandwich_profitability(u128::MAX, Some(u128::MAX), 10000, Some(u128::MAX), true);
        // Just verify it doesn't panic — any result is fine
        let _ = result.risk_level;
    }
}
