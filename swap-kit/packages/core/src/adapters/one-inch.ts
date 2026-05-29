import type { ISwapAdapter } from "./base.js";
import type { SwapIntent, QuoteResult, SwapResult, OneInchRouteData } from "../types.js";
import type { WalletClient, PublicClient, Hex, Address } from "viem";
import { getPublicClient } from "../utils/chain.js";
import { isNativeToken } from "../utils/token.js";
import { ERC20ABI } from "../abis/index.js";

export class OneInchFusionAdapter implements ISwapAdapter {
  readonly protocol = "1inch-fusion" as const;
  private apiKey: string;
  private baseUrl = "https://api.1inch.dev/fusion-plus";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  supports(intent: Required<SwapIntent>): boolean {
    // Skip if no API key is provided
    if (!this.apiKey) return false;

    const supportedChains = [1, 8453, 42161, 137, 56];
    return (
      supportedChains.includes(intent.fromChainId) &&
      supportedChains.includes(intent.toChainId)
    );
  }

  async quote(intent: Required<SwapIntent>): Promise<QuoteResult> {
    if (!this.apiKey) {
      throw new Error("1inch API key is required for Fusion+ quotes");
    }

    const isCrossChain = intent.fromChainId !== intent.toChainId;
    let url = "";

    // 1inch has different endpoints for same-chain (Swap API) vs cross-chain (Fusion+)
    if (isCrossChain) {
      url = `${this.baseUrl}/quoter/v1.0/quote/receive?srcChain=${intent.fromChainId}&dstChain=${intent.toChainId}&srcTokenAddress=${intent.fromToken}&dstTokenAddress=${intent.toToken}&amount=${intent.fromAmount}&walletAddress=${intent.recipient || "0x0000000000000000000000000000000000000001"}&enableEstimate=true`;
    } else {
      url = `https://api.1inch.dev/swap/v6.0/${intent.fromChainId}/quote?src=${intent.fromToken}&dst=${intent.toToken}&amount=${intent.fromAmount}&from=${intent.recipient || "0x0000000000000000000000000000000000000001"}`;
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`1inch API error (${res.status}): ${errorBody}`);
    }
    
    const data = await res.json() as any;
    const amountOut = BigInt(data.dstTokenAmount ?? data.toTokenAmount ?? data.dstAmount ?? "0");

    if (amountOut === 0n) {
      throw new Error("1inch returned zero output amount — no route found");
    }

    let gasPrice = 20_000_000_000n;
    try {
      const client = getPublicClient(intent.fromChainId);
      gasPrice = await client.getGasPrice();
    } catch (e) {
      // Fallback
    }
    const estimatedGas = data.estimatedGas ? BigInt(data.estimatedGas) * gasPrice : 0n;

    return {
      protocol: "1inch-fusion",
      amountOut,
      gasCostWei: isCrossChain ? 0n : estimatedGas,
      mevExposure: 0n,
      netAmountOut: amountOut > estimatedGas && !isCrossChain ? amountOut - estimatedGas : amountOut,
      priceImpactBps: data.estimatedPriceImpact
        ? Math.round(parseFloat(data.estimatedPriceImpact) * 100)
        : -1, // -1 means unknown
      routeData: {
        type: "1inch-fusion",
        orderHash: (data.orderHash || data.hash || "0x") as Hex,
        order: data,
        srcToken: intent.fromToken as string,
        dstToken: intent.toToken as string,
        fromAmount: intent.fromAmount.toString(),
        secrets: data.secrets || [],
        slippageBps: intent.maxSlippageBps,
      } as any,
      validUntil: Math.floor(Date.now() / 1000) + 120,
    };
  }

  async execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const routeData = quote.routeData as OneInchRouteData;
    const chainId = walletClient.chain!.id;
    const userAddress = walletClient.account!.address;

    // Determine if this is cross-chain Fusion+
    const isCrossChain = (routeData.order.srcChainId && routeData.order.dstChainId && routeData.order.srcChainId !== routeData.order.dstChainId);
    if (isCrossChain) {
      throw new Error("Cross-chain Fusion+ execution is not supported in this version. Requires 1inch Fusion SDK signature.");
    }

    const slippagePct = ((routeData as any).slippageBps || 50) / 100;
    const swapUrl = `https://api.1inch.dev/swap/v6.0/${chainId}/swap?src=${routeData.srcToken}&dst=${routeData.dstToken}&amount=${routeData.fromAmount}&from=${userAddress}&slippage=${slippagePct}&disableEstimate=true`;

    const res = await fetch(swapUrl, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`1inch Swap API error (${res.status}): ${errorBody}`);
    }

    const swapData = await res.json() as any;
    const tx = swapData.tx;

    if (!tx || !tx.to || !tx.data) {
      throw new Error("1inch Swap API did not return valid transaction data");
    }

    // Get balance before
    const isDstNative = isNativeToken(routeData.dstToken);
    const balanceBefore = isDstNative
      ? await publicClient.getBalance({ address: userAddress })
      : await publicClient.readContract({
          address: routeData.dstToken as Address,
          abi: ERC20ABI,
          functionName: "balanceOf",
          args: [userAddress],
        }) as bigint;

    // Send the real transaction
    const txHash = await walletClient.sendTransaction({
      account: walletClient.account!,
      chain: walletClient.chain!,
      to: tx.to as `0x${string}`,
      data: tx.data as Hex,
      value: BigInt(tx.value || "0"),
      gas: tx.gas ? BigInt(tx.gas) : undefined,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Get balance after
    const balanceAfter = isDstNative
      ? await publicClient.getBalance({ address: userAddress })
      : await publicClient.readContract({
          address: routeData.dstToken as Address,
          abi: ERC20ABI,
          functionName: "balanceOf",
          args: [userAddress],
        }) as bigint;

    const actualAmountOut = balanceAfter - balanceBefore;
    // MEV is extracted if actual is worse than quote, minus expected slippage (simplification)
    // Actually, any difference below the quoted exact output is a potential sandwich
    const mevExtractedWei = quote.amountOut > actualAmountOut ? quote.amountOut - actualAmountOut : 0n;

    return {
      txHash,
      protocol: "1inch-fusion",
      actualAmountOut,
      gasPaidWei: receipt.gasUsed * receipt.effectiveGasPrice,
      mevExtractedWei,
      route: quote,
      confirmedAt: Math.floor(Date.now() / 1000),
    };
  }
}
