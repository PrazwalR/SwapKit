//! Lightweight Ethereum JSON-RPC client for the MEV simulator.
//!
//! Connects to a real Ethereum node to fetch:
//! - Current gas prices (`eth_gasPrice`)
//! - Recent block data (`eth_getBlockByNumber`)
//!
//! The RPC URL is read from the `RPC_URL` environment variable.
//! If not set, all methods return `None` so the simulator can fall back to heuristics.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// JSON-RPC request envelope
#[derive(Serialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'a str,
    method: &'a str,
    params: serde_json::Value,
    id: u64,
}

/// JSON-RPC response envelope
#[derive(Deserialize)]
struct JsonRpcResponse {
    result: Option<serde_json::Value>,
}

/// A minimal Ethereum RPC client with timeout and graceful fallback.
pub struct EthRpcClient {
    url: String,
    client: reqwest::Client,
}

impl EthRpcClient {
    /// Create a new client from the `RPC_URL` environment variable.
    /// Returns `None` if the env var is not set.
    pub fn from_env() -> Option<Self> {
        let url = std::env::var("RPC_URL").ok()?;
        if url.is_empty() {
            return None;
        }

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2)) // Never block the server
            .build()
            .ok()?;

        // Log only the scheme + host. The API key lives in the URL path or query
        // for providers like Alchemy/Infura, so we must never log the tail of the URL.
        tracing::info!("MEV simulator connected to RPC host: {}", redact_rpc_url(&url));
        Some(Self { url, client })
    }

    /// Fetch the current gas price in wei.
    pub async fn gas_price(&self) -> Result<u128> {
        let body = JsonRpcRequest {
            jsonrpc: "2.0",
            method: "eth_gasPrice",
            params: serde_json::json!([]),
            id: 1,
        };

        let resp: JsonRpcResponse = self.client
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        let hex_str = resp.result
            .and_then(|v| v.as_str().map(String::from))
            .ok_or_else(|| anyhow::anyhow!("No result in eth_gasPrice response"))?;

        parse_hex_u128(&hex_str)
    }

    /// Fetch the `from` addresses of all transactions in a recent block.
    /// `block_offset` = 0 means latest, 1 means latest-1, etc.
    pub async fn get_block_tx_senders(&self, block_offset: u64) -> Result<Vec<String>> {
        // First get the latest block number
        let block_tag = if block_offset == 0 {
            "latest".to_string()
        } else {
            // Fetch latest block number first
            let num = self.get_block_number().await?;
            format!("0x{:x}", num.saturating_sub(block_offset))
        };

        let body = JsonRpcRequest {
            jsonrpc: "2.0",
            method: "eth_getBlockByNumber",
            params: serde_json::json!([block_tag, true]), // true = include full txs
            id: 2,
        };

        let resp: JsonRpcResponse = self.client
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        let block = resp.result
            .ok_or_else(|| anyhow::anyhow!("No result in eth_getBlockByNumber"))?;

        let txs = block.get("transactions")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        let senders: Vec<String> = txs.iter()
            .filter_map(|tx| tx.get("from").and_then(|f| f.as_str()).map(|s| s.to_lowercase()))
            .collect();

        Ok(senders)
    }

    /// Get the latest block number.
    async fn get_block_number(&self) -> Result<u64> {
        let body = JsonRpcRequest {
            jsonrpc: "2.0",
            method: "eth_blockNumber",
            params: serde_json::json!([]),
            id: 3,
        };

        let resp: JsonRpcResponse = self.client
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        let hex_str = resp.result
            .and_then(|v| v.as_str().map(String::from))
            .ok_or_else(|| anyhow::anyhow!("No result in eth_blockNumber"))?;

        let bytes = hex::decode(hex_str.trim_start_matches("0x"))?;
        let mut buf = [0u8; 8];
        let start = 8usize.saturating_sub(bytes.len());
        buf[start..].copy_from_slice(&bytes);
        Ok(u64::from_be_bytes(buf))
    }
}

/// Reduce an RPC URL to just `scheme://host`, dropping the path, query, fragment,
/// and any `user:pass@` userinfo — all of which can carry secrets (e.g. the API
/// key in an Alchemy/Infura URL). Safe to write to logs.
///
/// Returns `"<redacted>"` for anything that doesn't look like a URL, so a
/// malformed value can never accidentally leak in full.
fn redact_rpc_url(url: &str) -> String {
    let (scheme, rest) = match url.split_once("://") {
        Some(pair) => pair,
        None => return "<redacted>".to_string(),
    };

    // Authority ends at the first '/', '?', or '#'.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];

    // Strip any userinfo ("user:pass@host" -> "host").
    let host = match authority.rsplit_once('@') {
        Some((_userinfo, host)) => host,
        None => authority,
    };

    if scheme.is_empty() || host.is_empty() {
        return "<redacted>".to_string();
    }

    format!("{}://{}", scheme, host)
}

/// Parse a hex string (0x-prefixed) into u128.
fn parse_hex_u128(hex_str: &str) -> Result<u128> {
    let clean = hex_str.trim_start_matches("0x");
    let val = u128::from_str_radix(clean, 16)
        .map_err(|e| anyhow::anyhow!("Failed to parse hex '{}': {}", hex_str, e))?;
    Ok(val)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hex_u128() {
        assert_eq!(parse_hex_u128("0x3b9aca00").unwrap(), 1_000_000_000); // 1 gwei
        assert_eq!(parse_hex_u128("0x0").unwrap(), 0);
        assert_eq!(parse_hex_u128("0x1").unwrap(), 1);
        assert_eq!(parse_hex_u128("0xde0b6b3a7640000").unwrap(), 1_000_000_000_000_000_000); // 1 ETH
    }

    #[test]
    fn test_parse_hex_u128_invalid() {
        assert!(parse_hex_u128("0xZZZZ").is_err());
        assert!(parse_hex_u128("not_hex").is_err());
    }

    #[test]
    fn test_from_env_missing() {
        // When RPC_URL is not set, should return None
        std::env::remove_var("RPC_URL");
        assert!(EthRpcClient::from_env().is_none());
    }

    // ─── redact_rpc_url ────────────────────────────────────────────────────

    /// The Alchemy key is the trailing path segment — it must never appear.
    #[test]
    fn test_redact_alchemy_url_hides_key() {
        let key = "Abc123_SECRET_KEY_xyz789";
        let url = format!("https://eth-mainnet.g.alchemy.com/v2/{}", key);
        let redacted = redact_rpc_url(&url);
        assert_eq!(redacted, "https://eth-mainnet.g.alchemy.com");
        assert!(!redacted.contains(key), "redacted log must not contain the API key");
        assert!(!redacted.contains("v2"), "redacted log must not contain the path");
    }

    /// Infura-style key in path.
    #[test]
    fn test_redact_infura_url_hides_key() {
        let key = "0123456789abcdef0123456789abcdef";
        let url = format!("https://mainnet.infura.io/v3/{}", key);
        let redacted = redact_rpc_url(&url);
        assert_eq!(redacted, "https://mainnet.infura.io");
        assert!(!redacted.contains(key));
    }

    /// Key passed as a query parameter must also be dropped.
    #[test]
    fn test_redact_query_param_key_hidden() {
        let url = "https://rpc.example.com/path?apikey=SUPER_SECRET";
        let redacted = redact_rpc_url(url);
        assert_eq!(redacted, "https://rpc.example.com");
        assert!(!redacted.contains("SUPER_SECRET"));
        assert!(!redacted.contains("apikey"));
    }

    /// userinfo credentials (user:pass@host) must be stripped.
    #[test]
    fn test_redact_strips_userinfo_credentials() {
        let url = "https://user:p4ssw0rd@rpc.example.com/v2/KEY";
        let redacted = redact_rpc_url(url);
        assert_eq!(redacted, "https://rpc.example.com");
        assert!(!redacted.contains("p4ssw0rd"));
        assert!(!redacted.contains("user"));
        assert!(!redacted.contains("KEY"));
    }

    /// Host with a port is preserved (no secret there).
    #[test]
    fn test_redact_keeps_host_and_port() {
        assert_eq!(redact_rpc_url("http://127.0.0.1:8545"), "http://127.0.0.1:8545");
        assert_eq!(redact_rpc_url("http://localhost:8545/"), "http://localhost:8545");
    }

    /// A bare host with no path round-trips to itself.
    #[test]
    fn test_redact_no_path() {
        assert_eq!(redact_rpc_url("https://cloudflare-eth.com"), "https://cloudflare-eth.com");
    }

    /// Anything that isn't a URL is fully redacted rather than leaked.
    #[test]
    fn test_redact_malformed_is_fully_hidden() {
        assert_eq!(redact_rpc_url("not_a_url_just_a_secret"), "<redacted>");
        assert_eq!(redact_rpc_url(""), "<redacted>");
        assert_eq!(redact_rpc_url("://no-scheme/path"), "<redacted>");
        assert_eq!(redact_rpc_url("https://"), "<redacted>");
    }
}
