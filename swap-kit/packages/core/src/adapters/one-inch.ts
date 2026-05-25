import { SDK, PrivateKeyProviderConnector } from "@1inch/cross-chain-sdk";
import type { ISwapAdapter } from "./base.js";
import type { SwapIntent, QuoteResult, SwapResult, OneInchRouteData } from "../types.js";
import type { WalletClient, PublicClient, Hex } from "viem";

export class OneInchFusionAdapter implements ISwapAdapter {
  readonly protocol = "1inch-fusion" as const;
  private sdk: SDK;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.sdk = new SDK({
      url: "https://api.1inch.dev/fusion-plus",
      authKey: apiKey,
    });
  }

  supports(intent: Required<SwapIntent>): boolean {
    const supportedChains = [1, 8453, 42161, 137, 56];
    return (
      supportedChains.includes(intent.fromChainId) &&
      supportedChains.includes(intent.toChainId)
    );
  }

  async quote(intent: Required<SwapIntent>): Promise<QuoteResult> {
    const quoteParams = {
      srcChainId: intent.fromChainId as any,
      dstChainId: intent.toChainId as any,
      srcTokenAddress: intent.fromToken as string,
      dstTokenAddress: intent.toToken as string,
      amount: intent.fromAmount.toString(),
      walletAddress: "0x0000000000000000000000000000000000000001",
      enableEstimate: true,
    };

    const quote = await this.sdk.getQuote(quoteParams).catch((err: any) => {
      console.warn("1inch quote failed:", err.message);
      return { dstTokenAmount: "0" };
    });
    
    const amountOut = BigInt((quote as any).dstTokenAmount ?? "0");

    return {
      protocol: "1inch-fusion",
      amountOut,
      gasCostWei: 0n,
      mevExposure: 0n,
      netAmountOut: amountOut,
      priceImpactBps: 20, // stub
      routeData: {
        type: "1inch-fusion",
        orderHash: "0x" as Hex,
        order: {} as any,
        secrets: [],
      },
      validUntil: Math.floor(Date.now() / 1000) + 120,
    };
  }

  async execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const chainId = walletClient.chain!.id;

    // We will build the full 1inch execution logic when testing with real keys
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
