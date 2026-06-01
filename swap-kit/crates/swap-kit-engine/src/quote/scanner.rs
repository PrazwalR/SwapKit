//! Parallel Quote Scanner
//!
//! This module provides a placeholder quote scanning endpoint.
//! 
//! **IMPORTANT**: The Rust engine's `/quote` endpoint is a lightweight scaffold.
//! Real quote fetching is handled by the TypeScript SDK (`@swap-kit/core`),
//! which makes actual API calls to Paraswap, 1inch, and on-chain RPC calls
//! to the Uniswap V4 QuoterV2 contract. 
//!
//! The Rust engine's primary purpose is MEV simulation (`/simulate`) and
//! CREATE2 vanity address mining (`/mine`).

use anyhow::Result;
use swap_kit_types::{QuoteRequest, QuoteResponse, SingleQuote};

/// Fetch quotes from all supported protocols in parallel.
///
/// **NOTE**: This endpoint returns heuristic estimates, NOT real market data.
/// For production quotes, use the TypeScript SDK (`@swap-kit/core`) which
/// calls real APIs (Paraswap REST, 1inch REST, Uniswap V4 on-chain QuoterV2).
///
/// The estimates here are useful ONLY for:
/// - Testing the engine's HTTP infrastructure
/// - Providing rough order-of-magnitude estimates when the TS SDK is unavailable
///
/// Returns quotes sorted by amount_out descending (best first).
pub async fn get_best_quote(req: &QuoteRequest) -> Result<QuoteResponse> {
    let from_amount: u128 = req
        .from_amount
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid from_amount: must be a positive integer within u128 bounds"))?;

    // Fan out to all protocols in parallel
    let (uniswap, paraswap, oneinch) = tokio::join!(
        estimate_uniswap_v4(from_amount),
        estimate_paraswap(from_amount),
        estimate_1inch_fusion(from_amount),
    );

    let mut quotes = Vec::new();

    if let Ok(q) = uniswap {
        quotes.push(q);
    }
    if let Ok(q) = paraswap {
        quotes.push(q);
    }
    if let Ok(q) = oneinch {
        quotes.push(q);
    }

    // Sort by amount_out descending (best output first)
    quotes.sort_by(|a, b| {
        let a_out: u128 = a.amount_out.parse().unwrap_or(0);
        let b_out: u128 = b.amount_out.parse().unwrap_or(0);
        b_out.cmp(&a_out)
    });

    Ok(QuoteResponse { quotes })
}

/// Heuristic Uniswap V4 estimate.
///
/// **NOT a real quote.** Assumes ~2% total cost (fees + price impact).
/// Real V4 quotes come from the TypeScript SDK's on-chain QuoterV2 call.
async fn estimate_uniswap_v4(from_amount: u128) -> Result<SingleQuote> {
    let amount_out = from_amount.checked_mul(98).unwrap_or(0) / 100;
    let gas_cost = 130_000u128.checked_mul(2_000_000_000).unwrap_or(0);

    Ok(SingleQuote {
        protocol: "uniswap-v4".to_string(),
        amount_out: amount_out.to_string(),
        gas_cost_wei: gas_cost.to_string(),
        price_impact_bps: 30,
    })
}

/// Heuristic Paraswap estimate.
///
/// **NOT a real quote.** Assumes ~3% total cost.
/// Real Paraswap quotes come from the TypeScript SDK's call to apiv5.paraswap.io.
async fn estimate_paraswap(from_amount: u128) -> Result<SingleQuote> {
    let amount_out = from_amount.checked_mul(97).unwrap_or(0) / 100;
    let gas_cost = 150_000u128.checked_mul(2_000_000_000).unwrap_or(0);

    Ok(SingleQuote {
        protocol: "paraswap".to_string(),
        amount_out: amount_out.to_string(),
        gas_cost_wei: gas_cost.to_string(),
        price_impact_bps: 25,
    })
}

/// Heuristic 1inch Fusion+ estimate.
///
/// **NOT a real quote.** Assumes ~1.5% total cost.
/// Real 1inch quotes come from the TypeScript SDK's call to api.1inch.dev.
async fn estimate_1inch_fusion(from_amount: u128) -> Result<SingleQuote> {
    let amount_out = from_amount.checked_mul(985).unwrap_or(0) / 1000;

    Ok(SingleQuote {
        protocol: "1inch-fusion".to_string(),
        amount_out: amount_out.to_string(),
        gas_cost_wei: "0".to_string(),
        price_impact_bps: 20,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_best_quote() {
        let req = QuoteRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "1000000000000000000".to_string(), // 1 ETH
            chain_id: 1,
        };

        let result = get_best_quote(&req).await.unwrap();
        assert_eq!(result.quotes.len(), 3);

        // Best quote should be first (highest amount_out)
        let first_out: u128 = result.quotes[0].amount_out.parse().unwrap();
        let last_out: u128 = result.quotes[2].amount_out.parse().unwrap();
        assert!(first_out >= last_out);
    }

    #[tokio::test]
    async fn test_invalid_amount_returns_error() {
        let req = QuoteRequest {
            from_token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".to_string(),
            to_token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string(),
            from_amount: "not_a_number".to_string(),
            chain_id: 1,
        };
        let result = get_best_quote(&req).await;
        assert!(result.is_err());
    }
}
