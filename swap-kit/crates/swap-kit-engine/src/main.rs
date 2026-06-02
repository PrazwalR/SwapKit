//! swap-kit-engine — HTTP server for MEV simulation, quoting, and hook address mining.
//!
//! # Endpoints
//!
//! - `GET  /health`    — Health check
//! - `POST /simulate`  — MEV sandwich attack simulation (heuristic-based)
//! - `POST /mine`      — CREATE2 vanity address mining for Uniswap V4 hooks

use axum::{
    extract::Json,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use clap::{Parser, Subcommand};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;
use tower_http::cors::{CorsLayer, Any};
use tracing_subscriber::EnvFilter;

mod mev;
mod mining;

/// Limit concurrent mining requests to prevent rayon thread pool starvation.
static MINE_SEMAPHORE: Semaphore = Semaphore::const_new(2);

use swap_kit_types::{
    MineRequest, MineResult, SimulateRequest,
};

#[derive(Parser)]
#[command(name = "swap-kit-engine")]
#[command(about = "MEV simulation and Hook mining engine", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the HTTP server (default)
    Server,
    /// Mine a CREATE2 vanity address locally
    Mine {
        /// Deployer address
        #[arg(short, long)]
        deployer: String,
        /// Init code hash of the hook
        #[arg(short, long)]
        init_code_hash: String,
        /// Desired hex prefix
        #[arg(short, long)]
        prefix: String,
        /// Maximum iterations to brute force
        #[arg(short, long)]
        max_iterations: Option<u64>,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing with RUST_LOG env filter
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            EnvFilter::new("swap_kit_engine=info,tower_http=info")
        }))
        .init();

    let cli = Cli::parse();

    match cli.command.unwrap_or(Commands::Server) {
        Commands::Mine { deployer, init_code_hash, prefix, max_iterations } => {
            tracing::info!("Starting native offline CREATE2 miner...");
            let req = MineRequest {
                deployer,
                init_code_hash,
                prefix,
                max_iterations,
            };
            
            // Execute the offline CPU mining
            let result = tokio::task::spawn_blocking(move || {
                mining::hook_miner::mine(req)
            }).await?;
            
            // Print beautiful JSON result
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Commands::Server => {
            // CORS: configurable via CORS_ORIGIN env var, defaults to permissive for local dev
    let cors_origin = std::env::var("CORS_ORIGIN").unwrap_or_else(|_| "*".to_string());
    let cors = if cors_origin == "*" {
        tracing::warn!("CORS is set to allow ALL origins. Set CORS_ORIGIN env var for production.");
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        tracing::info!("CORS restricted to: {}", cors_origin);
        CorsLayer::new()
            .allow_origin(cors_origin.parse::<axum::http::HeaderValue>().expect("Invalid CORS_ORIGIN"))
            .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
            .allow_headers([axum::http::header::CONTENT_TYPE])
    };

    // Body size limit: 64KB max (largest valid request is ~500 bytes)
    let body_limit = axum::extract::DefaultBodyLimit::max(65_536);

    let app = Router::new()
        .route("/health", get(health))
        .route("/simulate", post(simulate_mev))
        .route("/mine", post(mine_hook_address))
        .layer(cors)
        .layer(body_limit);

    // Bind address: configurable via BIND_ADDR env var, defaults to 127.0.0.1 for safety
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3030".to_string());
    let addr: SocketAddr = bind_addr.parse().expect("Invalid BIND_ADDR");
    tracing::info!("swap-kit-engine listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("Server shut down gracefully");
    Ok(())
        }
    }
}

/// Wait for a shutdown signal (SIGINT / Ctrl+C).
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install Ctrl+C handler");
    tracing::info!("Shutdown signal received, draining connections…");
}

async fn health() -> &'static str {
    "ok"
}

async fn simulate_mev(Json(req): Json<SimulateRequest>) -> impl IntoResponse {
    match mev::simulator::simulate(&req).await {
        Ok(report) => (StatusCode::OK, Json(report)).into_response(),
        Err(e) => {
            tracing::warn!("MEV simulation failed: {e}, returning unknown-risk default");
            (StatusCode::OK, Json(mev::simulator::safe_default())).into_response()
        }
    }
}


async fn mine_hook_address(Json(req): Json<MineRequest>) -> impl IntoResponse {
    // Limit concurrent mining to prevent rayon thread pool starvation (H-7)
    let _permit = match MINE_SEMAPHORE.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            return (StatusCode::TOO_MANY_REQUESTS, Json(MineResult {
                salt: String::new(), address: String::new(), attempts: 0, found: false,
            })).into_response();
        }
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel.clone();

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(move || mining::hook_miner::mine_cancellable(req, &cancel_clone)),
    )
    .await;

    // Signal cancellation on timeout or completion
    cancel.store(true, Ordering::Relaxed);

    match result {
        Ok(Ok(mine_result)) => (StatusCode::OK, Json(mine_result)).into_response(),
        Ok(Err(_join_err)) => {
            let fallback = MineResult {
                salt: String::new(),
                address: String::new(),
                attempts: 0,
                found: false,
            };
            (StatusCode::INTERNAL_SERVER_ERROR, Json(fallback)).into_response()
        }
        Err(_timeout) => {
            tracing::warn!("Mining request timed out after 30s");
            let fallback = MineResult {
                salt: String::new(),
                address: String::new(),
                attempts: 0,
                found: false,
            };
            (StatusCode::REQUEST_TIMEOUT, Json(fallback)).into_response()
        }
    }
}
