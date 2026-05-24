import { isAddress, getAddress } from "viem";
import type { SwapIntent } from "../types.js";

// Well-known token addresses per chain
const KNOWN_TOKENS: Record<number, Record<string, `0x${string}`>> = {
  1: {
    ETH:  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    DAI:  "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  8453: { // Base
    ETH:  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
  },
  42161: { // Arbitrum
    ETH:  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  },
  137: { // Polygon
    MATIC: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDC:  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    WETH:  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  },
  56: { // BSC
    BNB:  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  10: { // Optimism
    ETH:  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
};

const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

/**
 * Resolves a token symbol (e.g. "ETH", "USDC") to its on-chain address
 * for the given chain. If already an address, checksums and returns it.
 */
export function resolveToken(
  token: string,
  chainId: number
): `0x${string}` {
  if (isAddress(token)) return getAddress(token);
  const upper = token.toUpperCase();
  const address = KNOWN_TOKENS[chainId]?.[upper];
  if (!address) {
    throw new Error(
      `Unknown token symbol "${token}" on chain ${chainId}. Pass a full address instead.`
    );
  }
  return address;
}

/**
 * Normalizes a user-provided SwapIntent into a fully-populated intent
 * with all optional fields filled with sensible defaults.
 */
export function normalizeIntent(raw: SwapIntent): Required<SwapIntent> {
  const now = Math.floor(Date.now() / 1000);

  return {
    fromToken:      resolveToken(raw.fromToken as string, raw.fromChainId),
    toToken:        resolveToken(raw.toToken as string, raw.toChainId ?? raw.fromChainId),
    fromAmount:     raw.fromAmount,
    fromChainId:    raw.fromChainId,
    toChainId:      raw.toChainId ?? raw.fromChainId,
    maxSlippageBps: raw.maxSlippageBps ?? 50,       // 0.5% default
    deadline:       raw.deadline ?? now + 1200,      // 20 min default
    protocols:      raw.protocols ?? ["uniswap-v4", "1inch-fusion", "paraswap"],
    skipMEVCheck:   raw.skipMEVCheck ?? false,
    recipient:      raw.recipient ?? "0x0000000000000000000000000000000000000000",
  };
}
