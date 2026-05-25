import type { ISwapAdapter } from "./base.js";
import type { SwapIntent, QuoteResult, SwapResult, ParaswapRouteData } from "../types.js";
import type { WalletClient, PublicClient, Hex, Address } from "viem";

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
      const gasCostWei = BigInt(priceData.priceRoute.gasCost || "0");

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
    } catch (error) {
      // Fallback to stub if API is unreachable (for development)
      console.warn("[swap-kit] Paraswap API call failed, using stub:", error);
      return this.stubQuote(intent);
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

    return {
      txHash,
      protocol:        "paraswap",
      actualAmountOut: quote.amountOut,
      gasPaidWei:      receipt.gasUsed * receipt.effectiveGasPrice,
      mevExtractedWei: 0n,
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
    const params = new URLSearchParams({
      srcToken:    intent.fromToken as string,
      destToken:   intent.toToken as string,
      amount:      intent.fromAmount.toString(),
      srcDecimals: "18",  // In production: look up from token registry
      destDecimals: "18",
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

  /**
   * Fallback stub quote when API is unreachable (dev/testing).
   */
  private stubQuote(intent: Required<SwapIntent>): QuoteResult {
    const amountOut = intent.fromAmount * 97n / 100n; // 3% price impact stub
    const gasCostWei = 150_000n * 2_000_000_000n;     // 150k gas @ 2 gwei

    return {
      protocol:       "paraswap",
      amountOut,
      gasCostWei,
      mevExposure:    0n,
      netAmountOut:   amountOut - gasCostWei,
      priceImpactBps: 30,
      routeData: {
        type:       "paraswap",
        priceRoute: {},
        calldata:   "0x" as Hex,
      },
      validUntil: Math.floor(Date.now() / 1000) + 60,
    };
  }
}
