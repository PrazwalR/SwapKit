//! Parallel Quote Scanner
//!
//! Fetches quotes from multiple on-chain sources in parallel using tokio.
//! In production, this would make actual RPC calls to Uniswap V4 Quoter,
//! Paraswap API, and 1inch Fusion+ API.

use anyhow::Result;
use swap_kit_types::{QuoteRequest, QuoteResponse, SingleQuote};

/// Fetch quotes from all supported protocols in parallel.
///
/// Returns quotes sorted by amount_out descending (best first).
pub async fn get_best_quote(req: &QuoteRequest) -> Result<QuoteResponse> {
    // Fan out to all protocols in parallel
    let (uniswap, paraswap, oneinch) = tokio::join!(
        quote_uniswap_v4(req),
        quote_paraswap(req),
        quote_1inch_fusion(req),
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

/// Simulate a Uniswap V4 quote.
///
/// In production: call QuoterV2.quoteExactInputSingle() via RPC.
async fn quote_uniswap_v4(req: &QuoteRequest) -> Result<SingleQuote> {
    let from_amount: u128 = req.from_amount.parse().unwrap_or(0);

    // Uniswap V4 typically offers ~0.3% fee for major pairs
    // Simulate 98% output (2% price impact + fees)
    let amount_out = from_amount * 98 / 100;

    // V4 gas is ~130k due to singleton + flash accounting
    let gas_cost = 130_000u128 * 2_000_000_000; // 130k gas @ 2 gwei

    Ok(SingleQuote {
        protocol: "uniswap-v4".to_string(),
        amount_out: amount_out.to_string(),
        gas_cost_wei: gas_cost.to_string(),
        price_impact_bps: 30,
    })
}

/// Simulate a Paraswap quote.
///
/// In production: call Paraswap REST API at apiv5.paraswap.io/prices
async fn quote_paraswap(req: &QuoteRequest) -> Result<SingleQuote> {
    let from_amount: u128 = req.from_amount.parse().unwrap_or(0);

    // Paraswap aggregates multiple DEXs, typically gets slightly better rates
    let amount_out = from_amount * 97 / 100; // 3% total cost

    // Paraswap gas varies but typically ~150k
    let gas_cost = 150_000u128 * 2_000_000_000;

    Ok(SingleQuote {
        protocol: "paraswap".to_string(),
        amount_out: amount_out.to_string(),
        gas_cost_wei: gas_cost.to_string(),
        price_impact_bps: 25,
    })
}

/// Simulate a 1inch Fusion+ quote.
///
/// In production: call 1inch Fusion+ API.
/// Fusion+ is gasless for the user (resolvers pay gas).
async fn quote_1inch_fusion(req: &QuoteRequest) -> Result<SingleQuote> {
    let from_amount: u128 = req.from_amount.parse().unwrap_or(0);

    // Fusion+ resolver competition typically yields good rates
    let amount_out = from_amount * 985 / 1000; // 1.5% total cost

    Ok(SingleQuote {
        protocol: "1inch-fusion".to_string(),
        amount_out: amount_out.to_string(),
        gas_cost_wei: "0".to_string(), // Gasless for user
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
}
