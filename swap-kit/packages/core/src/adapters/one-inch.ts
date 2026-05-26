import type { ISwapAdapter } from "./base.js";
import type { SwapIntent, QuoteResult, SwapResult, OneInchRouteData } from "../types.js";
import type { WalletClient, PublicClient, Hex } from "viem";

export class OneInchFusionAdapter implements ISwapAdapter {
  readonly protocol = "1inch-fusion" as const;
  private apiKey: string;
  private baseUrl = "https://api.1inch.dev/fusion-plus";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  supports(intent: Required<SwapIntent>): boolean {
    const supportedChains = [1, 8453, 42161, 137, 56];
    return (
      supportedChains.includes(intent.fromChainId) &&
      supportedChains.includes(intent.toChainId)
    );
  }

  async quote(intent: Required<SwapIntent>): Promise<QuoteResult> {
    const isCrossChain = intent.fromChainId !== intent.toChainId;
    let url = "";

    // 1inch has different endpoints for same-chain (Fusion) vs cross-chain (Fusion+)
    if (isCrossChain) {
      url = `${this.baseUrl}/quoter/v1.0/quote/receive?srcChain=${intent.fromChainId}&dstChain=${intent.toChainId}&srcTokenAddress=${intent.fromToken}&dstTokenAddress=${intent.toToken}&amount=${intent.fromAmount}&walletAddress=${intent.recipient || "0x0000000000000000000000000000000000000001"}&enableEstimate=true`;
    } else {
      url = `https://api.1inch.dev/swap/v6.0/${intent.fromChainId}/quote?src=${intent.fromToken}&dst=${intent.toToken}&amount=${intent.fromAmount}&from=${intent.recipient || "0x0000000000000000000000000000000000000001"}`;
    }

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      
      if (!res.ok) {
        throw new Error(`1inch API error: ${await res.text()}`);
      }
      
      const data = await res.json() as any;
      const amountOut = BigInt(data.dstTokenAmount ?? data.toTokenAmount ?? data.dstAmount ?? "0");

      return {
        protocol: "1inch-fusion",
        amountOut,
        gasCostWei: 0n, // Intent swaps are gasless for the maker
        mevExposure: 0n, // Protected by resolvers
        netAmountOut: amountOut,
        priceImpactBps: 20, // stub
        routeData: {
          type: "1inch-fusion",
          orderHash: "0x" as Hex,
          order: data,
          secrets: [],
        },
        validUntil: Math.floor(Date.now() / 1000) + 120,
      };
    } catch (err: any) {
      console.warn("1inch quote failed:", err.message);
      throw err;
    }
  }

  async execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    // In a real execution, we would:
    // 1. Sign the order via walletClient.signTypedData
    // 2. Submit the signed order to the 1inch Relayer API
    // For now, we mock the execution hash since we're testing integrations.
    
    const orderHash = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
    
    return {
      txHash: orderHash,
      protocol: "1inch-fusion",
      actualAmountOut: quote.amountOut,
      gasPaidWei: 0n,
      mevExtractedWei: 0n,
      route: quote,
      confirmedAt: Math.floor(Date.now() / 1000),
    };
  }
}
