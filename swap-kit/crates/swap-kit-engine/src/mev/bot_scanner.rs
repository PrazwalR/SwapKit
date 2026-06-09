//! Known MEV Bot Scanner
//!
//! Scans recent Ethereum blocks for transactions from known sandwich bot addresses.
//! Uses a curated list of publicly identified MEV bots.
//!
//! If the RPC client is unavailable, returns an empty list (graceful fallback).

use crate::mev::rpc::EthRpcClient;

/// Well-known MEV sandwich bot addresses (lowercase, all publicly documented).
/// Sources:
/// - https://eigenphi.io
/// - https://mevblocker.io
/// - https://etherscan.io/accounts/label/mev-bot
const KNOWN_BOTS: &[&str] = &[
    // Jared From Subway — the most prolific sandwich bot on Ethereum
    "0xae2fc483527b8ef99eb5d9b44875f005ba1fae13",
    // Large MEV bots identified by Flashbots & EigenPhi
    "0x6b75d8af000000e20b7a7ddf000ba900b4009a80",
    "0x00000000003b3cc22af3ae1eac0440bcee416b40",
    "0x56178a0d5f301baf6cf3e1cd53d9863437345bf9",
    "0xa57bd00134b2850b2a1c55860c9e9ea100fdd6cf",
    "0x000000000035b5e5ad9019092c665357240f594e",
    "0x5050e08de731a0b8a5f8a68f87f0c12b6e414e3c",
    "0xd050e0a4838d74769228b49dff97241b4ef3805d",
    // Wintermute (market maker, not malicious, but relevant for MEV analysis)
    "0x00000000ae347930bd1aa7a33a6c2066d1b59a3b",
    // Flashbots builder
    "0xdafea492d9c6733ae3d56b7ed1adb60692c98bc5",
];

/// Result of a bot scan.
pub struct BotScanResult {
    /// Bot addresses found active in recent blocks
    pub detected_bots: Vec<String>,
    /// Number of blocks scanned (diagnostic; surfaced via logs and tests)
    #[allow(dead_code)]
    pub blocks_scanned: u64,
    /// Total transactions scanned (diagnostic; surfaced via logs and tests)
    #[allow(dead_code)]
    pub txs_scanned: u64,
}

/// Scan the last N blocks for transactions from known MEV bot addresses.
///
/// Returns which bots are actively transacting on-chain.
/// If the RPC client is `None`, returns an empty result (graceful fallback).
pub async fn scan_recent_blocks(
    rpc: Option<&EthRpcClient>,
    blocks_to_scan: u64,
) -> BotScanResult {
    let rpc = match rpc {
        Some(r) => r,
        None => return BotScanResult {
            detected_bots: vec![],
            blocks_scanned: 0,
            txs_scanned: 0,
        },
    };

    let mut detected: Vec<String> = Vec::new();
    let mut total_txs: u64 = 0;
    let mut scanned: u64 = 0;

    for offset in 0..blocks_to_scan {
        match rpc.get_block_tx_senders(offset).await {
            Ok(senders) => {
                total_txs += senders.len() as u64;
                scanned += 1;

                for sender in &senders {
                    let sender_lower = sender.to_lowercase();
                    if KNOWN_BOTS.contains(&sender_lower.as_str()) && !detected.contains(&sender_lower) {
                        detected.push(sender_lower);
                    }
                }
            }
            Err(err) => {
                tracing::warn!("Failed to fetch block at offset {}: {}", offset, err);
                // Don't fail the entire scan — just skip this block
            }
        }
    }

    tracing::info!(
        "Bot scan complete: scanned {} blocks, {} txs, found {} active bots",
        scanned, total_txs, detected.len()
    );

    BotScanResult {
        detected_bots: detected,
        blocks_scanned: scanned,
        txs_scanned: total_txs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_known_bots_list_is_lowercase() {
        for bot in KNOWN_BOTS {
            assert_eq!(*bot, bot.to_lowercase(), "Bot address must be lowercase: {}", bot);
        }
    }

    #[test]
    fn test_known_bots_are_valid_eth_addresses() {
        for bot in KNOWN_BOTS {
            assert!(bot.starts_with("0x"), "Must start with 0x: {}", bot);
            assert_eq!(bot.len(), 42, "Must be 42 chars (0x + 40 hex): {}", bot);
        }
    }

    #[tokio::test]
    async fn test_scan_with_no_rpc_returns_empty() {
        let result = scan_recent_blocks(None, 5).await;
        assert!(result.detected_bots.is_empty());
        assert_eq!(result.blocks_scanned, 0);
        assert_eq!(result.txs_scanned, 0);
    }
}
