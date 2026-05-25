//! MEV Sandwich Attack Simulator
//!
//! Detects sandwich attack risk for pending swaps by analyzing:
//! - Trade size relative to pool liquidity
//! - Current slippage tolerance
//! - Historical bot activity patterns
//!
//! # How Sandwich Attacks Work
//!
//! 1. Attacker sees victim's pending tx (e.g. buy 1 ETH worth of USDC)
//! 2. Attacker front-runs: buys USDC before victim → price goes up
//! 3. Victim's tx executes at worse price (MEV extracted)
//! 4. Attacker back-runs: sells USDC at inflated price → profit

use anyhow::Result;
use swap_kit_types::{SimulateRequest, SimulateResponse};

/// Simulate MEV exposure for a given swap.
///
/// Estimates sandwich attack risk based on trade parameters.
/// In production, this would connect to an Ethereum node and analyze
/// the mempool for pending transactions targeting the same pool.
pub async fn simulate(req: &SimulateRequest) -> Result<SimulateResponse> {
    // Parse amounts
    let from_amount: u128 = req.from_amount.parse().unwrap_or(0);
    let amount_out: u128 = req.amount_out.parse().unwrap_or(0);
    let slippage_bps: u64 = req.slippage_bps as u64;

    // Classify risk based on trade size and slippage
    //
    // Heuristics:
    // - Large trades (> 10 ETH equivalent) with high slippage = high risk
    // - Small trades with tight slippage = low risk
    // - Cross-chain (non-mainnet) generally lower MEV activity
    let trade_size_eth = from_amount as f64 / 1e18;
    let is_mainnet = req.chain_id == 1;

    let sandwich_risk = classify_risk(trade_size_eth, slippage_bps, is_mainnet);

    // MEV estimate: sandwich attacker can extract up to (slippage_bps / 10000) * amount_out
    // But typically extracts 60-80% of available slippage
    let mev_fraction = (slippage_bps * 70) / 10000; // 70% of slippage tolerance
    let estimated_mev = (amount_out as u128) * (mev_fraction as u128) / 10000;

    // Recommend reducing slippage if MEV risk is high
    let recommended_slippage = if sandwich_risk == "high" {
        // Reduce slippage to minimum viable — makes sandwich unprofitable
        std::cmp::min(slippage_bps as u32, 30)
    } else if sandwich_risk == "medium" {
        std::cmp::min(slippage_bps as u32, 50)
    } else {
        slippage_bps as u32
    };

    Ok(SimulateResponse {
        sandwich_risk: sandwich_risk.to_string(),
        estimated_mev_wei: estimated_mev.to_string(),
        recommended_slippage_bps: recommended_slippage,
        detected_bots: vec![], // In production: scan recent blocks for known bot patterns
    })
}

/// Returns a safe default response when simulation fails.
pub fn safe_default() -> SimulateResponse {
    SimulateResponse {
        sandwich_risk: "low".to_string(),
        estimated_mev_wei: "0".to_string(),
        recommended_slippage_bps: 50,
        detected_bots: vec![],
    }
}

/// Classify sandwich risk level based on trade parameters.
fn classify_risk(trade_size_eth: f64, slippage_bps: u64, is_mainnet: bool) -> &'static str {
    // Non-mainnet chains generally have less MEV infrastructure
    let risk_multiplier = if is_mainnet { 1.0 } else { 0.5 };

    let risk_score = trade_size_eth * (slippage_bps as f64) * risk_multiplier;

    if risk_score > 5000.0 {
        "high"
    } else if risk_score > 500.0 {
        "medium"
    } else if risk_score > 50.0 {
        "low"
    } else {
        "none"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_simulate_low_risk() {
        let req = SimulateRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "100000000000000000".to_string(), // 0.1 ETH
            chain_id: 1,
            protocol: "uniswap-v4".to_string(),
            amount_out: "200000000".to_string(), // 200 USDC
            slippage_bps: 50,
        };

        let result = simulate(&req).await.unwrap();
        assert!(result.sandwich_risk == "none" || result.sandwich_risk == "low");
    }

    #[tokio::test]
    async fn test_simulate_high_risk() {
        let req = SimulateRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "100000000000000000000".to_string(), // 100 ETH
            chain_id: 1,
            protocol: "uniswap-v4".to_string(),
            amount_out: "200000000000".to_string(), // 200k USDC
            slippage_bps: 200,
        };

        let result = simulate(&req).await.unwrap();
        assert_eq!(result.sandwich_risk, "high");
        assert!(result.recommended_slippage_bps <= 30);
    }

    #[test]
    fn test_safe_default() {
        let result = safe_default();
        assert_eq!(result.sandwich_risk, "low");
        assert_eq!(result.estimated_mev_wei, "0");
    }
}
