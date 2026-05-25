//! CREATE2 Vanity Address Miner
//!
//! Mines salt values for CREATE2 deployments that produce addresses with
//! desired prefixes. Used for Uniswap V4 hooks where the hook address
//! encodes its permission flags (the address must have specific bits set).
//!
//! # CREATE2 Address Formula
//!
//! ```text
//! address = keccak256(0xff ++ deployer ++ salt ++ keccak256(init_code))[12:]
//! ```
//!
//! # Uniswap V4 Hook Flags
//!
//! In V4, hook permissions are encoded in the hook's address:
//! - Bit 0 (0x01): BEFORE_INITIALIZE
//! - Bit 1 (0x02): AFTER_INITIALIZE
//! - Bit 2 (0x04): BEFORE_ADD_LIQUIDITY
//! - Bit 3 (0x08): AFTER_ADD_LIQUIDITY
//! - Bit 4 (0x10): BEFORE_REMOVE_LIQUIDITY
//! - Bit 5 (0x20): AFTER_REMOVE_LIQUIDITY
//! - Bit 6 (0x40): BEFORE_SWAP
//! - Bit 7 (0x80): AFTER_SWAP

use rayon::prelude::*;
use swap_kit_types::{MineRequest, MineResult};
use tiny_keccak::{Hasher, Keccak};

/// Mine a CREATE2 salt that produces an address with the desired prefix.
///
/// Uses rayon for parallel computation across all available CPU cores.
/// Returns the first salt found that matches, or reports no match after
/// max_iterations attempts.
pub fn mine(req: MineRequest) -> MineResult {
    let max_iterations = req.max_iterations.unwrap_or(1_000_000);

    // Parse deployer address (remove 0x prefix)
    let deployer_hex = req.deployer.strip_prefix("0x").unwrap_or(&req.deployer);
    let deployer_bytes = hex_decode(deployer_hex);

    // Parse init_code_hash (remove 0x prefix)
    let hash_hex = req
        .init_code_hash
        .strip_prefix("0x")
        .unwrap_or(&req.init_code_hash);
    let init_code_hash = hex_decode(hash_hex);

    // Parse desired prefix (remove 0x prefix)
    let prefix = req.prefix.strip_prefix("0x").unwrap_or(&req.prefix);
    let prefix_bytes = hex_decode(prefix);

    // Use rayon to parallelize the search across CPU cores
    // Split the search space into chunks
    let chunk_size = 10_000u64;
    let num_chunks = (max_iterations + chunk_size - 1) / chunk_size;

    let result = (0..num_chunks)
        .into_par_iter()
        .find_map_any(|chunk_idx| {
            let start = chunk_idx * chunk_size;
            let end = std::cmp::min(start + chunk_size, max_iterations);

            for i in start..end {
                // Create 32-byte salt from iteration number
                let mut salt = [0u8; 32];
                let i_bytes = i.to_be_bytes();
                salt[24..32].copy_from_slice(&i_bytes);

                // Compute CREATE2 address
                let address = compute_create2_address(&deployer_bytes, &salt, &init_code_hash);

                // Check if address starts with desired prefix
                if address.starts_with(&prefix_bytes) {
                    return Some(MineResult {
                        salt: format!("0x{}", hex_encode(&salt)),
                        address: format!("0x{}", hex_encode(&address)),
                        attempts: i + 1,
                        found: true,
                    });
                }
            }

            None
        });

    result.unwrap_or(MineResult {
        salt: String::new(),
        address: String::new(),
        attempts: max_iterations,
        found: false,
    })
}

/// Compute a CREATE2 address.
///
/// address = keccak256(0xff ++ deployer ++ salt ++ init_code_hash)[12:]
fn compute_create2_address(deployer: &[u8], salt: &[u8; 32], init_code_hash: &[u8]) -> Vec<u8> {
    let mut hasher = Keccak::v256();
    hasher.update(&[0xff]);
    hasher.update(deployer);
    hasher.update(salt);
    hasher.update(init_code_hash);

    let mut hash = [0u8; 32];
    hasher.finalize(&mut hash);

    // Address is the last 20 bytes of the hash
    hash[12..32].to_vec()
}

/// Decode a hex string into bytes.
fn hex_decode(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            let end = std::cmp::min(i + 2, hex.len());
            u8::from_str_radix(&hex[i..end], 16).unwrap_or(0)
        })
        .collect()
}

/// Encode bytes as a hex string (lowercase).
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_create2_address() {
        // Known CREATE2 test vector
        let deployer = hex_decode("0000000000000000000000000000000000000000");
        let mut salt = [0u8; 32];
        let init_code_hash =
            hex_decode("0000000000000000000000000000000000000000000000000000000000000000");

        let address = compute_create2_address(&deployer, &salt, &init_code_hash);
        assert_eq!(address.len(), 20);
    }

    #[test]
    fn test_mine_finds_prefix() {
        let req = MineRequest {
            deployer: "0x0000000000000000000000000000000000000001".to_string(),
            init_code_hash:
                "0x0000000000000000000000000000000000000000000000000000000000000001"
                    .to_string(),
            prefix: "00".to_string(), // Find address starting with 0x00
            max_iterations: Some(100_000),
        };

        let result = mine(req);
        // With 100k iterations, should find a match for a 1-byte prefix (1/256 chance)
        assert!(result.found, "Should find a matching address within 100k iterations");
        assert!(result.address.starts_with("0x00"));
    }

    #[test]
    fn test_hex_roundtrip() {
        let original = vec![0xde, 0xad, 0xbe, 0xef];
        let encoded = hex_encode(&original);
        assert_eq!(encoded, "deadbeef");
        let decoded = hex_decode(&encoded);
        assert_eq!(decoded, original);
    }
}
