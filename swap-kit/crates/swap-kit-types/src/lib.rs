//! Shared types for the swap-kit engine.
//!
//! This crate contains all request/response types used by the swap-kit Rust engine.
//! It has minimal dependencies (only serde) so it can be used as a standalone types crate.

use serde::{Deserialize, Serialize};

// ─── MEV Simulation ─────────────────────────────────────────────────────────

/// Request to simulate MEV exposure for a swap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulateRequest {
    pub from_token: String,
    pub to_token: String,
    pub from_amount: String,
    pub chain_id: u64,
    pub protocol: String,
    pub amount_out: String,
    pub slippage_bps: u32,
}

/// MEV simulation result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulateResponse {
    pub sandwich_risk: String,
    pub estimated_mev_wei: String,
    pub recommended_slippage_bps: u32,
    pub detected_bots: Vec<String>,
}

// ─── Quoting ────────────────────────────────────────────────────────────────

/// Request for a multi-source quote.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteRequest {
    pub from_token: String,
    pub to_token: String,
    pub from_amount: String,
    pub chain_id: u64,
}

/// A single quote from one protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingleQuote {
    pub protocol: String,
    pub amount_out: String,
    pub gas_cost_wei: String,
    pub price_impact_bps: u32,
}

/// Aggregated quote response.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QuoteResponse {
    pub quotes: Vec<SingleQuote>,
}

// ─── Hook Mining ────────────────────────────────────────────────────────────

/// Request to mine a CREATE2 vanity address for a Uniswap V4 hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MineRequest {
    /// The deployer/factory address (20 bytes hex)
    pub deployer: String,
    /// The keccak256 hash of the init code (32 bytes hex)
    pub init_code_hash: String,
    /// Desired address prefix (hex string, e.g. "00" for leading zero)
    pub prefix: String,
    /// Max iterations before giving up. Default: 1_000_000
    pub max_iterations: Option<u64>,
}

/// Result of a CREATE2 mining operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MineResult {
    /// The salt that produces the desired address (32 bytes hex)
    pub salt: String,
    /// The resulting contract address (20 bytes hex)
    pub address: String,
    /// Number of attempts taken
    pub attempts: u64,
    /// Whether a match was found
    pub found: bool,
}
