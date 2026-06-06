//! Production-Grade MEV Sandwich Attack Simulator
//!
//! # Architecture
//!
//! The simulator runs a 3-stage pipeline:
//!
//! 1. **Fetch real data** — Gas prices, recent bot activity from Ethereum RPC
//! 2. **Calculate profitability** — Uses real gas costs to determine if a
//!    sandwich attack is economically viable
//! 3. **Return enriched response** — Real detected bots, calculated MEV estimate,
//!    and optimal slippage recommendation
//!
//! # Graceful Fallback
//!
//! If `RPC_URL` is not set or the RPC is unreachable, the simulator falls back
//! to heuristic mode (same behavior as the previous version). The engine never
//! crashes or blocks due to RPC issues.

use anyhow::Result;
use swap_kit_types::{SimulateRequest, SimulateResponse};

use crate::mev::rpc::EthRpcClient;
use crate::mev::liquidity::calculate_sandwich_profitability;
use crate::mev::bot_scanner::scan_recent_blocks;

/// Number of recent blocks to scan for bot activity.
/// 5 blocks ≈ 1 minute on mainnet. Keeps the scan fast.
const BLOCKS_TO_SCAN: u64 = 5;

/// Simulate MEV exposure for a given swap using real on-chain data.
///
/// Pipeline:
/// 1. Parse and validate input amounts
/// 2. Fetch real gas price from Ethereum RPC (if available)
/// 3. Scan recent blocks for known sandwich bot activity
/// 4. Calculate sandwich attack profitability using real gas costs
/// 5. Return enriched response
pub async fn simulate(req: &SimulateRequest) -> Result<SimulateResponse> {
    // ─── Stage 0: Parse & validate inputs ──────────────────────────────
    let from_amount: u128 = req
        .from_amount
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid from_amount: must be a positive integer within u128 bounds"))?;

    let amount_out: u128 = req
        .amount_out
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid amount_out: must be a positive integer within u128 bounds"))?;

    if from_amount == 0 {
        return Err(anyhow::anyhow!("from_amount must be greater than zero"));
    }

    let slippage_bps = req.slippage_bps as u64;
    let is_mainnet = req.chain_id == 1;

    // ─── Stage 1: Fetch real on-chain data ─────────────────────────────
    let rpc = EthRpcClient::from_env();

    // Fetch gas price (falls back to None if RPC unavailable)
    let gas_price: Option<u128> = match &rpc {
        Some(client) => {
            match client.gas_price().await {
                Ok(gp) => {
                    tracing::info!("Real gas price: {} wei ({:.1} gwei)", gp, gp as f64 / 1e9);
                    Some(gp)
                }
                Err(err) => {
                    tracing::warn!("Failed to fetch gas price, using fallback: {}", err);
                    None
                }
            }
        }
        None => {
            tracing::debug!("No RPC_URL set — using heuristic gas estimation");
            None
        }
    };

    // Scan recent blocks for known MEV bots (concurrent with gas fetch would
    // be ideal, but sequential is simpler and the scan is fast with 5 blocks)
    let bot_scan = scan_recent_blocks(rpc.as_ref(), BLOCKS_TO_SCAN).await;

    // ─── Stage 2: Calculate sandwich profitability ─────────────────────
    let profitability = calculate_sandwich_profitability(
        amount_out,
        slippage_bps,
        gas_price,
        is_mainnet,
    );

    // ─── Stage 3: Build enriched response ──────────────────────────────

    // Use the profitability calculator's MEV estimate
    let estimated_mev = profitability.extractable_value_wei;

    // Log the analysis for observability
    if gas_price.is_some() {
        tracing::info!(
            "MEV analysis: risk={}, profitable={}, attacker_profit={} wei, gas_cost={} wei, bots_found={}",
            profitability.risk_level,
            profitability.is_profitable,
            profitability.attacker_profit_wei,
            profitability.attacker_gas_cost_wei,
            bot_scan.detected_bots.len(),
        );
    }

    // If bots are active AND attack is profitable, always escalate to "high"
    let final_risk = if !bot_scan.detected_bots.is_empty() && profitability.is_profitable {
        "high"
    } else {
        profitability.risk_level
    };

    // If bots are active, tighten slippage recommendation further
    let final_slippage = if !bot_scan.detected_bots.is_empty() {
        std::cmp::min(profitability.recommended_slippage_bps, 30) // Max 30 bps when bots are active
    } else {
        profitability.recommended_slippage_bps
    };

    Ok(SimulateResponse {
        sandwich_risk: final_risk.to_string(),
        estimated_mev_wei: estimated_mev.to_string(),
        recommended_slippage_bps: final_slippage,
        detected_bots: bot_scan.detected_bots,
    })
}

/// Returns a safe default response when simulation fails.
/// Returns "unknown" risk to honestly signal the simulation could not complete,
/// rather than misleadingly reporting "low" risk.
pub fn safe_default() -> SimulateResponse {
    SimulateResponse {
        sandwich_risk: "unknown".to_string(),
        estimated_mev_wei: "0".to_string(),
        recommended_slippage_bps: 30, // Conservative default when we can't analyze
        detected_bots: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_simulate_low_risk() {
        // Small trade, tight slippage → low or no risk
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
        assert!(
            result.sandwich_risk == "none" || result.sandwich_risk == "low",
            "Small trade should be low/no risk, got: {}", result.sandwich_risk
        );
    }

    #[tokio::test]
    async fn test_simulate_high_risk() {
        // Large trade, high slippage → high risk
        let req = SimulateRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "100000000000000000000".to_string(), // 100 ETH
            chain_id: 1,
            protocol: "uniswap-v4".to_string(),
            amount_out: "200000000000000000000".to_string(), // 200 ETH equivalent (large)
            slippage_bps: 200,
        };

        let result = simulate(&req).await.unwrap();
        assert_eq!(result.sandwich_risk, "high");
        assert!(result.recommended_slippage_bps <= 50);
    }

    #[test]
    fn test_safe_default() {
        let result = safe_default();
        assert_eq!(result.sandwich_risk, "unknown");
        assert_eq!(result.estimated_mev_wei, "0");
        assert_eq!(result.recommended_slippage_bps, 30);
    }

    #[tokio::test]
    async fn test_simulate_negative_amount() {
        let req = SimulateRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "-100000000000000000".to_string(),
            chain_id: 1,
            protocol: "uniswap-v4".to_string(),
            amount_out: "200000000".to_string(),
            slippage_bps: 50,
        };
        assert!(simulate(&req).await.is_err());
    }

    #[tokio::test]
    async fn test_simulate_massive_amount() {
        let req = SimulateRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "99999999999999999999999999999999999999999999999999999999999".to_string(),
            chain_id: 1,
            protocol: "uniswap-v4".to_string(),
            amount_out: "200000000".to_string(),
            slippage_bps: 50,
        };
        assert!(simulate(&req).await.is_err());
    }

    #[tokio::test]
    async fn test_simulate_invalid_type_amount() {
        let req = SimulateRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "invalid_amount".to_string(),
            chain_id: 1,
            protocol: "uniswap-v4".to_string(),
            amount_out: "invalid_out".to_string(),
            slippage_bps: 50,
        };
        assert!(simulate(&req).await.is_err());
    }

    #[tokio::test]
    async fn test_simulate_zero_amount() {
        let req = SimulateRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "0".to_string(),
            chain_id: 1,
            protocol: "uniswap-v4".to_string(),
            amount_out: "200000000".to_string(),
            slippage_bps: 50,
        };
        assert!(simulate(&req).await.is_err());
    }

    #[tokio::test]
    async fn test_simulate_overflow_mev() {
        let req = SimulateRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "100000000000000000000".to_string(),
            chain_id: 1,
            protocol: "uniswap-v4".to_string(),
            amount_out: "340282366920938463463374607431768211455".to_string(), // u128::MAX
            slippage_bps: 2000,
        };
        let result = simulate(&req).await.unwrap();
        // Should not panic — overflow is handled via checked_mul
        assert!(!result.sandwich_risk.is_empty());
    }
}
