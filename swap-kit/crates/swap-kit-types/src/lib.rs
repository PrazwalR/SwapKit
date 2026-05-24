use serde::{Deserialize, Serialize};

// ── MEV Simulation ──────────────────────────────────────────────────────

/// Request body for the `/simulate` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulateRequest {
    pub from_token: String,
    pub to_token: String,
    pub from_amount: String,
    pub chain_id: u64,
    pub protocol: String,
    pub amount_out: String,
    pub slippage_bps: u64,
}

/// Response body for the `/simulate` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulateResponse {
    pub sandwich_risk: String,
    pub estimated_mev_wei: String,
    pub recommended_slippage_bps: u64,
    pub detected_bots: Vec<String>,
}

// ── Quote Aggregation ───────────────────────────────────────────────────

/// Request body for the `/quote` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteRequest {
    pub from_token: String,
    pub to_token: String,
    pub from_amount: String,
    pub chain_id: u64,
}

/// A single DEX quote.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quote {
    pub protocol: String,
    pub amount_out: String,
    pub gas_cost_wei: String,
}

/// Response body for the `/quote` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteResponse {
    pub quotes: Vec<Quote>,
}

// ── CREATE2 Vanity Mining ───────────────────────────────────────────────

/// Request body for the `/mine` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MineRequest {
    pub deployer: String,
    pub init_code_hash: String,
    pub prefix: String,
}

/// Result returned by the vanity‐address miner.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MineResult {
    pub salt: String,
    pub address: String,
    pub attempts: u64,
}
