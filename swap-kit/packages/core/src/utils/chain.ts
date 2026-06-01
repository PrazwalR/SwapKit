import { createPublicClient, http, type PublicClient, type Chain } from "viem";
import { mainnet, base, arbitrum, optimism, polygon, bsc, sepolia } from "viem/chains";

// ─── Chain Registry ─────────────────────────────────────────────────────────

export interface ChainConfig {
  chain: Chain;
  rpcUrl: string;
  blockExplorerUrl: string;
  nativeSymbol: string;
  /** Average block time in seconds */
  blockTime: number;
  /** Number of confirmations to wait for finality */
  confirmations: number;
}

const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  1: {
    chain:             mainnet,
    rpcUrl:            "https://eth.drpc.org",
    blockExplorerUrl:  "https://etherscan.io",
    nativeSymbol:      "ETH",
    blockTime:         12,
    confirmations:     2,
  },
  8453: {
    chain:             base,
    rpcUrl:            "https://mainnet.base.org",
    blockExplorerUrl:  "https://basescan.org",
    nativeSymbol:      "ETH",
    blockTime:         2,
    confirmations:     5,
  },
  42161: {
    chain:             arbitrum,
    rpcUrl:            "https://arb1.arbitrum.io/rpc",
    blockExplorerUrl:  "https://arbiscan.io",
    nativeSymbol:      "ETH",
    blockTime:         0.25,
    confirmations:     5,
  },
  10: {
    chain:             optimism,
    rpcUrl:            "https://mainnet.optimism.io",
    blockExplorerUrl:  "https://optimistic.etherscan.io",
    nativeSymbol:      "ETH",
    blockTime:         2,
    confirmations:     5,
  },
  137: {
    chain:             polygon,
    rpcUrl:            "https://polygon-rpc.com",
    blockExplorerUrl:  "https://polygonscan.com",
    nativeSymbol:      "MATIC",
    blockTime:         2,
    confirmations:     10,
  },
  56: {
    chain:             bsc,
    rpcUrl:            "https://bsc-dataseed.binance.org",
    blockExplorerUrl:  "https://bscscan.com",
    nativeSymbol:      "BNB",
    blockTime:         3,
    confirmations:     5,
  },
  11155111: {
    chain:             sepolia,
    rpcUrl:            "https://rpc.sepolia.org",
    blockExplorerUrl:  "https://sepolia.etherscan.io",
    nativeSymbol:      "ETH",
    blockTime:         12,
    confirmations:     2,
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns the chain configuration for a given chain ID.
 * Falls back to a dynamic minimal config if the chain is unlisted.
 */
export function getChainConfig(chainId: number): ChainConfig {
  const config = CHAIN_CONFIGS[chainId];
  if (config) return config;

  // Dynamic fallback for unknown chains (relies on user providing a publicClient later)
  return {
    chain: {
      id: chainId,
      name: `Chain ${chainId}`,
      network: `chain-${chainId}`,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://cloudflare-eth.com"] }, public: { http: ["https://cloudflare-eth.com"] } },
    } as any,
    rpcUrl: "https://cloudflare-eth.com",
    blockExplorerUrl: "https://etherscan.io",
    nativeSymbol: "ETH",
    blockTime: 12, // Safe generic default
    confirmations: 2,
  };
}

/**
 * Register custom user-injected chains into the global registry.
 */
export function registerCustomChains(chains: ChainConfig[]) {
  for (const chain of chains) {
    CHAIN_CONFIGS[chain.chain.id] = chain;
  }
}

/**
 * Returns all supported chain IDs.
 */
export function getSupportedChainIds(): number[] {
  return Object.keys(CHAIN_CONFIGS).map(Number);
}

/**
 * Returns true if the chain ID is supported.
 */
export function isChainSupported(chainId: number): boolean {
  return chainId in CHAIN_CONFIGS;
}

/** Cache of public clients per chain */
const clientCache = new Map<string, PublicClient>();

/**
 * Creates (or returns a cached) public client for the given chain.
 * Optionally accepts a custom RPC URL override.
 */
export function getPublicClient(
  chainId: number,
  rpcUrl?: string
): PublicClient {
  const config = getChainConfig(chainId);
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const alchemyUrl = alchemyKey
    ? {
        1: `https://eth-mainnet.alchemyapi.io/v2/${alchemyKey}`,
        8453: `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`,
        42161: `https://arb-mainnet.g.alchemy.com/v2/${alchemyKey}`,
        10: `https://opt-mainnet.g.alchemy.com/v2/${alchemyKey}`,
        137: `https://polygon-mainnet.g.alchemy.com/v2/${alchemyKey}`,
        56: `https://bsc-mainnet.g.alchemy.com/v2/${alchemyKey}`,
      }[chainId]
    : undefined;
  const envOverrides: Record<number, string | undefined> = {
    1: process.env.RPC_ETHEREUM,
    8453: process.env.RPC_BASE,
    42161: process.env.RPC_ARBITRUM,
  };
  const url = rpcUrl ?? alchemyUrl ?? envOverrides[chainId] ?? config.rpcUrl;
  const cacheKey = `${chainId}:${url}`;

  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const client = createPublicClient({
    chain: config.chain,
    transport: http(url),
  });

  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Returns a block explorer URL for a transaction hash.
 */
export function getTxExplorerUrl(chainId: number, txHash: string): string {
  const config = getChainConfig(chainId);
  return `${config.blockExplorerUrl}/tx/${txHash}`;
}

/**
 * Returns a block explorer URL for an address.
 */
export function getAddressExplorerUrl(chainId: number, address: string): string {
  const config = getChainConfig(chainId);
  return `${config.blockExplorerUrl}/address/${address}`;
}
