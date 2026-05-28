import type { ISwapAdapter } from "./base.js";
import type { SwapIntent, QuoteResult, SwapResult, ParaswapRouteData } from "../types.js";
import type { WalletClient, PublicClient, Hex, Address } from "viem";
import { getPublicClient } from "../utils/chain.js";
import { isNativeToken, getTokenDecimals } from "../utils/token.js";
import { ERC20ABI } from "../abis/index.js";

// Paraswap API base URLs per chain
const PARASWAP_API = "https://apiv5.paraswap.io";

// Augustus Swapper contract addresses per chain
const AUGUSTUS_ADDRESSES: Record<number, Address> = {
  1:     "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57",
  8453:  "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57",
  42161: "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57",
  137:   "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57",
  56:    "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57",
  10:    "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57",
};

// Token transfer proxy — the contract that actually moves tokens
const TOKEN_TRANSFER_PROXY: Record<number, Address> = {
  1:     "0x216B4B4Ba9F3e719726886d34a177484278Bfcae",
  8453:  "0x216B4B4Ba9F3e719726886d34a177484278Bfcae",
  42161: "0x216B4B4Ba9F3e719726886d34a177484278Bfcae",
  137:   "0x216B4B4Ba9F3e719726886d34a177484278Bfcae",
  56:    "0x216B4B4Ba9F3e719726886d34a177484278Bfcae",
  10:    "0x216B4B4Ba9F3e719726886d34a177484278Bfcae",
};

interface ParaswapPriceResponse {
  priceRoute: {
    srcAmount: string;
    destAmount: string;
    gasCost: string;
    gasCostUSD: string;
    srcUSD: string;
    destUSD: string;
    bestRoute: unknown[];
  };
}

interface ParaswapTxResponse {
  to: string;
  from: string;
  value: string;
  data: string;
  chainId: number;
  gasPrice: string;
}

export class ParaswapAdapter implements ISwapAdapter {
  readonly protocol = "paraswap" as const;

  supports(intent: Required<SwapIntent>): boolean {
    // Paraswap supports major EVM chains, same-chain only
    const supported = [1, 8453, 42161, 137, 56, 10];
    return (
      supported.includes(intent.fromChainId) &&
      intent.fromChainId === intent.toChainId
    );
  }

  async quote(intent: Required<SwapIntent>): Promise<QuoteResult> {
    try {
      // Step 1: Get price/rate from Paraswap API
      const priceData = await this.getRate(intent);
      const amountOut = BigInt(priceData.priceRoute.destAmount);

      // MEDIUM-7 fix: Paraswap API returns gas cost in units, not Wei. We need gasPrice.
      let gasPrice = 20_000_000_000n;
      try {
        const client = getPublicClient(intent.fromChainId);
        gasPrice = await client.getGasPrice();
      } catch (e) {
        // Fallback
      }
      const gasCostWei = BigInt(priceData.priceRoute.gasCost || "0") * gasPrice;

      // Step 2: Calculate price impact from USD values
      const srcUSD = parseFloat(priceData.priceRoute.srcUSD || "0");
      const destUSD = parseFloat(priceData.priceRoute.destUSD || "0");
      const priceImpactBps = srcUSD > 0
        ? Math.round(((srcUSD - destUSD) / srcUSD) * 10000)
        : 0;

      return {
        protocol:       "paraswap",
        amountOut,
        gasCostWei,
        mevExposure:    0n,     // filled by MEVGuard
        netAmountOut:   amountOut - gasCostWei,
        priceImpactBps: Math.max(0, priceImpactBps),
        routeData: {
          type:       "paraswap",
          priceRoute: priceData.priceRoute,
          calldata:   "0x" as Hex,  // filled during execute via buildTx
        },
        validUntil: Math.floor(Date.now() / 1000) + 60,
      };
    } catch (error: any) {
      // Do NOT return fake data — let the quote engine skip this adapter
      console.warn("[swap-kit] Paraswap API call failed:", error.message);
      throw error;
    }
  }

  async execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const routeData = quote.routeData as ParaswapRouteData;
    const chainId = walletClient.chain!.id;
    const userAddress = walletClient.account!.address;

    // Step 1: Build transaction via Paraswap API
    const txData = await this.buildTx(
      chainId,
      routeData.priceRoute,
      userAddress,
      quote.amountOut
    );

    // Get balance before
    const isDstNative = isNativeToken((routeData.priceRoute as any).destToken);
    const balanceBefore = isDstNative
      ? await publicClient.getBalance({ address: userAddress })
      : await publicClient.readContract({
          address: (routeData.priceRoute as any).destToken as Address,
          abi: ERC20ABI,
          functionName: "balanceOf",
          args: [userAddress],
        }) as bigint;

    // Step 2: Submit the transaction
    const txHash = await walletClient.sendTransaction({
      account: walletClient.account!,
      chain:   walletClient.chain!,
      to:      txData.to as Address,
      data:    txData.data as Hex,
      value:   BigInt(txData.value || "0"),
    });

    // Step 3: Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Get balance after
    const balanceAfter = isDstNative
      ? await publicClient.getBalance({ address: userAddress })
      : await publicClient.readContract({
          address: (routeData.priceRoute as any).destToken as Address,
          abi: ERC20ABI,
          functionName: "balanceOf",
          args: [userAddress],
        }) as bigint;

    const actualAmountOut = balanceAfter - balanceBefore;
    // P-4/P-5 fix: Real measurements
    const mevExtractedWei = quote.amountOut > actualAmountOut ? quote.amountOut - actualAmountOut : 0n;

    return {
      txHash,
      protocol:        "paraswap",
      actualAmountOut,
      gasPaidWei:      receipt.gasUsed * receipt.effectiveGasPrice,
      mevExtractedWei,
      route:           quote,
      confirmedAt:     Math.floor(Date.now() / 1000),
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Calls Paraswap's /prices endpoint to get the best rate.
   * https://developers.paraswap.network/api/get-rate-for-a-token-pair
   */
  private async getRate(intent: Required<SwapIntent>): Promise<ParaswapPriceResponse> {
    const client = getPublicClient(intent.fromChainId);
    const srcDecimals = await getTokenDecimals(intent.fromToken as Address, client as any);
    const destDecimals = await getTokenDecimals(intent.toToken as Address, client as any);

    const params = new URLSearchParams({
      srcToken:    intent.fromToken as string,
      destToken:   intent.toToken as string,
      amount:      intent.fromAmount.toString(),
      srcDecimals: srcDecimals.toString(),
      destDecimals: destDecimals.toString(),
      side:        "SELL",
      network:     intent.fromChainId.toString(),
      excludeDEXS: "",    // Include all DEXs
    });

    const response = await fetch(`${PARASWAP_API}/prices?${params}`, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Paraswap /prices returned ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<ParaswapPriceResponse>;
  }

  /**
   * Returns the number of decimals for well-known tokens.
   * Falls back to 18 for unknown tokens (most ERC-20s use 18).
   */
  private getKnownDecimals(address: string): number {
    const addr = address.toLowerCase();
    // Native ETH/MATIC/BNB sentinel
    if (addr === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") return 18;
    // USDC (all chains)
    if (addr === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") return 6;   // Ethereum
    if (addr === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") return 6;   // Base
    if (addr === "0xaf88d065e77c8cc2239327c5edb3a432268e5831") return 6;   // Arbitrum
    if (addr === "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359") return 6;   // Polygon
    // USDT
    if (addr === "0xdac17f958d2ee523a2206206994597c13d831ec7") return 6;   // Ethereum
    if (addr === "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9") return 6;   // Arbitrum
    // WBTC
    if (addr === "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599") return 8;   // Ethereum
    // WETH
    if (addr === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return 18;  // Ethereum
    if (addr === "0x4200000000000000000000000000000000000006") return 18;  // Base
    if (addr === "0x82af49447d8a07e3bd95bd0d56f35241523fbab1") return 18;  // Arbitrum
    // DAI
    if (addr === "0x6b175474e89094c44da98b954eedeac495271d0f") return 18;  // Ethereum
    // Default
    return 18;
  }

  /**
   * Calls Paraswap's /transactions endpoint to build the swap calldata.
   * https://developers.paraswap.network/api/build-parameters-for-transaction
   */
  private async buildTx(
    chainId: number,
    priceRoute: unknown,
    userAddress: Address,
    destAmount: bigint,
  ): Promise<ParaswapTxResponse> {
    const response = await fetch(`${PARASWAP_API}/transactions/${chainId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        srcToken:    (priceRoute as any).srcToken,
        destToken:   (priceRoute as any).destToken,
        srcAmount:   (priceRoute as any).srcAmount,
        destAmount:  destAmount.toString(),
        priceRoute,
        userAddress,
        partner:     "swap-kit",
        slippage:    50,  // 0.5% — matches default
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Paraswap /transactions returned ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<ParaswapTxResponse>;
  }

}
