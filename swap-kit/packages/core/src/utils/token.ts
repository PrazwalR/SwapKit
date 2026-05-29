import type { Address, PublicClient } from "viem";
import { ERC20ABI } from "../abis/index.js";

/** Cache of token decimals to avoid repeated RPC calls */
const decimalsCache = new Map<string, number>();

/** Standard native token sentinel address used across DeFi */
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/**
 * Checks if the given address represents the native gas token (ETH, MATIC, BNB, etc.)
 */
export function isNativeToken(address: string): boolean {
  return address.toLowerCase() === NATIVE_TOKEN.toLowerCase();
}

/**
 * Returns the number of decimals for a given token.
 * Native tokens always return 18.
 * Results are cached to avoid repeated RPC calls.
 */
export async function getTokenDecimals(
  address: Address,
  publicClient: PublicClient
): Promise<number> {
  if (isNativeToken(address)) return 18;

  const cacheKey = `${publicClient.chain?.id ?? 0}:${address.toLowerCase()}`;
  const cached = decimalsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const decimals = await publicClient.readContract({
      address,
      abi: ERC20ABI,
      functionName: "decimals",
    });
    const result = Number(decimals);
    decimalsCache.set(cacheKey, result);
    return result;
  } catch (err) { console.error("DECIMALS ERROR:", err);
    // Default to 18 if contract call fails
    return 18;
  }
}

/**
 * Returns the token symbol for a given address.
 */
export async function getTokenSymbol(
  address: Address,
  publicClient: PublicClient
): Promise<string> {
  if (isNativeToken(address)) {
    // Return chain-appropriate native token name
    const chainId = publicClient.chain?.id ?? 1;
    const nativeSymbols: Record<number, string> = {
      1: "ETH", 8453: "ETH", 42161: "ETH", 10: "ETH",
      137: "MATIC", 56: "BNB",
    };
    return nativeSymbols[chainId] ?? "ETH";
  }

  try {
    const symbol = await publicClient.readContract({
      address,
      abi: ERC20ABI,
      functionName: "symbol",
    });
    return symbol as string;
  } catch (err) { console.error("DECIMALS ERROR:", err);
    return "UNKNOWN";
  }
}

/**
 * Formats a raw token amount (bigint) into a human-readable string
 * with the appropriate number of decimal places.
 *
 * @example
 * formatTokenAmount(1000000000000000000n, 18) // "1.0"
 * formatTokenAmount(1500000n, 6) // "1.5"
 */
export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  maxDisplayDecimals: number = 6
): string {
  const divisor = 10n ** BigInt(decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  if (fractionalPart === 0n) {
    return wholePart.toString();
  }

  // Pad fractional part with leading zeros
  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
  // Trim trailing zeros and limit display decimals
  const trimmed = fractionalStr.slice(0, maxDisplayDecimals).replace(/0+$/, "");

  if (trimmed === "") {
    return wholePart.toString();
  }

  return `${wholePart}.${trimmed}`;
}

/**
 * Parses a human-readable token amount string into a bigint.
 *
 * @example
 * parseTokenAmount("1.5", 18) // 1500000000000000000n
 * parseTokenAmount("100", 6) // 100000000n
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + paddedFraction);
}

/**
 * Returns the balance of a token for a given address.
 * For native tokens, uses eth_getBalance.
 */
export async function getTokenBalance(
  tokenAddress: Address,
  ownerAddress: Address,
  publicClient: PublicClient
): Promise<bigint> {
  if (isNativeToken(tokenAddress)) {
    return publicClient.getBalance({ address: ownerAddress });
  }

  try {
    const balance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20ABI,
      functionName: "balanceOf",
      args: [ownerAddress],
    });
    return balance as bigint;
  } catch (err) { console.error("DECIMALS ERROR:", err);
    return 0n;
  }
}
