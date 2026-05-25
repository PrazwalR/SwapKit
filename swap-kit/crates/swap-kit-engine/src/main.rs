//! swap-kit-engine — HTTP server for MEV simulation, quoting, and hook address mining.
//!
//! # Endpoints
//!
//! - `GET  /health`    — Health check
//! - `POST /simulate`  — MEV sandwich attack simulation
//! - `POST /quote`     — Multi-protocol quote aggregation
//! - `POST /mine`      — CREATE2 vanity address mining for Uniswap V4 hooks

use axum::{
    extract::Json,
    routing::{get, post},
    Router,
};
use std::net::SocketAddr;
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

mod mev;
mod quote;
mod mining;

use swap_kit_types::{
    MineRequest, MineResult, QuoteRequest, QuoteResponse, SimulateRequest, SimulateResponse,
};

#[tokio::main]
async fn main() {
    // Initialize tracing with RUST_LOG env filter
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            EnvFilter::new("swap_kit_engine=info,tower_http=info")
        }))
        .init();

    let app = Router::new()
        .route("/health", get(health))
        .route("/simulate", post(simulate_mev))
        .route("/quote", post(get_quote))
        .route("/mine", post(mine_hook_address))
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([0, 0, 0, 0], 3030));
    tracing::info!("swap-kit-engine listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> &'static str {
    "ok"
}

async fn simulate_mev(Json(req): Json<SimulateRequest>) -> Json<SimulateResponse> {
    let report = mev::simulator::simulate(&req)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("MEV simulation failed: {e}, returning safe default");
            mev::simulator::safe_default()
        });
    Json(report)
}

async fn get_quote(Json(req): Json<QuoteRequest>) -> Json<QuoteResponse> {
    let quotes = quote::scanner::get_best_quote(&req)
        .await
        .unwrap_or_default();
    Json(quotes)
}

async fn mine_hook_address(Json(req): Json<MineRequest>) -> Json<MineResult> {
    // Run mining in a blocking thread to avoid blocking the async runtime
    let result = tokio::task::spawn_blocking(move || mining::hook_miner::mine(req))
        .await
        .unwrap_or_else(|_e| MineResult {
            salt: String::new(),
            address: String::new(),
            attempts: 0,
            found: false,
        });
    Json(result)
}
