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
/// # Arguments
/// * `amount_out` — Expected output of the user's swap (in token wei)
/// * `slippage_bps` — User's slippage tolerance in basis points
/// * `gas_price_wei` — Current gas price from `eth_gasPrice` (in wei)
/// * `is_mainnet` — Whether this is Ethereum mainnet (higher bot activity)
///
/// # Returns
/// A `ProfitabilityResult` with the full breakdown.
pub fn calculate_sandwich_profitability(
    amount_out: u128,
    slippage_bps: u64,
    gas_price_wei: Option<u128>,
    is_mainnet: bool,
) -> ProfitabilityResult {
    // Step 1: Calculate extractable value
    // = amount_out × (slippage_bps / 10000) × extraction_efficiency
    let slippage_value = amount_out
        .checked_mul(slippage_bps as u128)
        .map(|v| v / BPS)
        .unwrap_or(amount_out);

    let extractable_value = slippage_value
        .checked_mul(EXTRACTION_EFFICIENCY_BPS)
        .map(|v| v / BPS)
        .unwrap_or(slippage_value);

    // Step 2: Calculate attacker's gas cost (2 transactions)
    let gas_cost = match gas_price_wei {
        Some(gp) => SANDWICH_GAS_UNITS
            .checked_mul(gp)
            .unwrap_or(u128::MAX),
        None => {
            // No real gas price — fall back to a conservative estimate
            // Assume ~30 gwei (moderate mainnet conditions)
            let default_gas = if is_mainnet { 30_000_000_000u128 } else { 1_000_000_000u128 };
            SANDWICH_GAS_UNITS.checked_mul(default_gas).unwrap_or(u128::MAX)
        }
    };

    // Step 3: Is it profitable?
    let is_profitable = extractable_value > gas_cost;
    let attacker_profit = if is_profitable {
        extractable_value - gas_cost
    } else {
        0
    };

    // Step 4: Classify risk based on profit margin
    let risk_level = if !is_profitable {
        "none"
    } else {
        // Calculate profit as a percentage of gas cost to gauge severity
        // High = profit > 5× gas cost (easy money for bots)
        // Medium = profit > 1× gas cost (viable but risky)
        // Low = profit > 0 but < 1× gas cost (barely worth it)
        let profit_to_gas_ratio = if gas_cost > 0 {
            attacker_profit / gas_cost
        } else {
            u128::MAX // Division by zero guard — infinite profit
        };

        match profit_to_gas_ratio {
            5.. => "high",
            1..=4 => "medium",
            _ => "low",
        }
    };

    // Mainnet has more bot competition, so bump risk level up one notch
    let risk_level = if is_mainnet && risk_level == "low" {
        "medium"
    } else if is_mainnet && risk_level == "medium" {
        "high"
    } else {
        risk_level
    };

    // Step 5: Recommend slippage that makes the attack unprofitable
    // We need: extractable_value ≤ gas_cost
    // slippage_value × 0.7 ≤ gas_cost
    // amount_out × (slippage / 10000) × 0.7 ≤ gas_cost
    // slippage ≤ (gas_cost × 10000) / (amount_out × 0.7)
    let recommended_slippage_bps = if amount_out > 0 && slippage_bps > 0 {
        let numerator = gas_cost
            .checked_mul(BPS * BPS)
            .unwrap_or(u128::MAX);
        let denominator = amount_out
            .checked_mul(EXTRACTION_EFFICIENCY_BPS)
            .unwrap_or(1);

        let optimal = (numerator / denominator) as u32;
        // Clamp between 1 bps (0.01%) and the user's original slippage
        optimal.clamp(1, slippage_bps as u32)
    } else {
        slippage_bps as u32 // 0 slippage = user accepts no slippage, nothing to recommend
    };

    ProfitabilityResult {
        is_profitable,
        attacker_profit_wei: attacker_profit,
        extractable_value_wei: extractable_value,
        attacker_gas_cost_wei: gas_cost,
        risk_level,
        recommended_slippage_bps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_large_trade_high_slippage_low_gas_is_profitable() {
        // 100 ETH swap, 200 bps slippage, 5 gwei gas
        let amount_out = 100_000_000_000_000_000_000u128; // 100 ETH
        let result = calculate_sandwich_profitability(
            amount_out,
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
        // 0.01 ETH swap, 10 bps slippage, 200 gwei gas
        let amount_out = 10_000_000_000_000_000u128; // 0.01 ETH
        let result = calculate_sandwich_profitability(
            amount_out,
            10,     // 0.1% slippage
            Some(200_000_000_000), // 200 gwei
            true,
        );
        assert!(!result.is_profitable, "Tiny trade with tight slippage and high gas should NOT be profitable");
        assert_eq!(result.risk_level, "none");
        assert_eq!(result.attacker_profit_wei, 0);
    }

    #[test]
    fn test_no_gas_price_uses_fallback() {
        let amount_out = 50_000_000_000_000_000_000u128; // 50 ETH
        let result = calculate_sandwich_profitability(
            amount_out,
            100,    // 1% slippage
            None,   // No RPC → fallback gas estimate
            true,
        );
        // Should still produce a valid result using default 30 gwei
        assert!(result.attacker_gas_cost_wei > 0);
    }

    #[test]
    fn test_zero_amount_out_is_safe() {
        let result = calculate_sandwich_profitability(0, 200, Some(10_000_000_000), true);
        assert!(!result.is_profitable);
        assert_eq!(result.risk_level, "none");
    }

    #[test]
    fn test_zero_slippage_is_safe() {
        let amount_out = 100_000_000_000_000_000_000u128;
        let result = calculate_sandwich_profitability(amount_out, 0, Some(10_000_000_000), true);
        assert!(!result.is_profitable);
        assert_eq!(result.risk_level, "none");
    }

    #[test]
    fn test_l2_has_lower_risk_than_mainnet() {
        let amount_out = 10_000_000_000_000_000_000u128; // 10 ETH
        let mainnet = calculate_sandwich_profitability(amount_out, 100, Some(10_000_000_000), true);
        let l2 = calculate_sandwich_profitability(amount_out, 100, Some(10_000_000_000), false);

        // L2 risk should be same or lower than mainnet for identical parameters
        let risk_order = |r: &str| -> u8 {
            match r { "high" => 3, "medium" => 2, "low" => 1, _ => 0 }
        };
        assert!(risk_order(l2.risk_level) <= risk_order(mainnet.risk_level),
            "L2 risk ({}) should be <= mainnet risk ({})", l2.risk_level, mainnet.risk_level);
    }

    #[test]
    fn test_recommended_slippage_makes_attack_unprofitable() {
        let amount_out = 50_000_000_000_000_000_000u128; // 50 ETH
        let gas_price = 20_000_000_000u128; // 20 gwei
        let result = calculate_sandwich_profitability(amount_out, 200, Some(gas_price), true);

        if result.is_profitable {
            // Re-run with the recommended slippage — should be unprofitable
            let safer = calculate_sandwich_profitability(
                amount_out,
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
        // u128::MAX amount — should not panic
        let result = calculate_sandwich_profitability(u128::MAX, 10000, Some(u128::MAX), true);
        // Just verify it doesn't panic — any result is fine
        let _ = result.risk_level;
    }
}
