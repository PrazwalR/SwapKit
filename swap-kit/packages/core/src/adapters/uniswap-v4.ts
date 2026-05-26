import {
  encodeFunctionData,
  encodeAbiParameters,
  type Address,
  type Hex,
  type WalletClient,
  type PublicClient,
} from "viem";
import { UniversalRouterABI } from "../abis/index.js";
import type { ISwapAdapter } from "./base.js";
import type {
  SwapIntent,
  QuoteResult,
  SwapResult,
  PoolKey,
  UniswapV4RouteData,
} from "../types.js";

// Chain-specific addresses (Uniswap v4 deployments)
const UNISWAP_V4_ADDRESSES: Record<number, {
  poolManager:     Address;
  universalRouter: Address;
  permit2:         Address;
  stateView:       Address;
  quoter:          Address;
}> = {
  1: {
    poolManager:     "0x000000000004444c5dc75cB358380D2e3dE08A90",
    universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    stateView:       "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
    quoter:          "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
  },
  8453: { // Base
    poolManager:     "0x498581ff718922c3f8e6a244956af099b2652b2b",
    universalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    stateView:       "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
    quoter:          "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
  },
  42161: { // Arbitrum
    poolManager:     "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
    universalRouter: "0xa51afafe0263b40edaef0df8781ea9aa03e381a3",
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    stateView:       "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
    quoter:          "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
  },
};

// V4_SWAP command
const V4_SWAP_COMMAND = 0x10;

// V4 Router Actions
const ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL:           0x0c,
  TAKE_ALL:             0x0f,
};

export class UniswapV4Adapter implements ISwapAdapter {
  readonly protocol = "uniswap-v4" as const;

  supports(intent: Required<SwapIntent>): boolean {
    const supported = [1, 8453, 42161];
    return (
      supported.includes(intent.fromChainId) &&
      intent.fromChainId === intent.toChainId // v4 is single-chain
    );
  }

  async quote(intent: Required<SwapIntent>): Promise<QuoteResult> {
    const addrs = UNISWAP_V4_ADDRESSES[intent.fromChainId];
    if (!addrs) throw new Error(`Uniswap v4 not deployed on chain ${intent.fromChainId}`);

    const poolKey = await this.findBestPool(
      intent.fromToken as Address,
      intent.toToken as Address,
      intent.fromChainId
    );

    const amountOut = await this.getQuoteExact(
      poolKey,
      intent.fromAmount,
      intent.fromChainId
    );

    const calldata = this.encodeSwapCalldata(
      poolKey,
      intent.fromAmount,
      amountOut,
      intent.maxSlippageBps,
      intent.recipient,
      intent.deadline
    );

    const gasCostWei = await this.estimateGas(intent.fromChainId, calldata);

    return {
      protocol:       "uniswap-v4",
      amountOut,
      gasCostWei,
      mevExposure:    0n,
      netAmountOut:   amountOut - gasCostWei,
      priceImpactBps: await this.getPriceImpact(poolKey, intent.fromAmount, amountOut, intent.fromChainId),
      routeData: {
        type:              "uniswap-v4",
        poolKey,
        hookData:          "0x",
        sqrtPriceLimitX96: 0n,
        calldata,
      },
      validUntil: Math.floor(Date.now() / 1000) + 30,
    };
  }

  async execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const routeData = quote.routeData as UniswapV4RouteData;
    const addrs = UNISWAP_V4_ADDRESSES[walletClient.chain!.id];

    const isNativeIn = this.isNativeETH(routeData.poolKey.currency0) || this.isNativeETH(routeData.poolKey.currency1);
    const value = isNativeIn ? (quote as any).originalAmountIn || 0n : 0n;

    const txHash = await walletClient.sendTransaction({
      account: walletClient.account!,
      chain:   walletClient.chain!,
      to:      addrs.universalRouter,
      data:    routeData.calldata,
      value:   value,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    return {
      txHash,
      protocol:          "uniswap-v4",
      actualAmountOut:   quote.amountOut,
      gasPaidWei:        receipt.gasUsed * receipt.effectiveGasPrice,
      mevExtractedWei:   0n,
      route:             quote,
      confirmedAt:       Math.floor(Date.now() / 1000),
    };
  }

  private async findBestPool(
    token0: Address,
    token1: Address,
    chainId: number
  ): Promise<PoolKey> {
    const t0 = this.isNativeETH(token0) ? "0x0000000000000000000000000000000000000000" : token0;
    const t1 = this.isNativeETH(token1) ? "0x0000000000000000000000000000000000000000" : token1;

    const [currency0, currency1] = BigInt(t0) < BigInt(t1)
      ? [t0, t1]
      : [t1, t0];

    return {
      currency0: currency0 as Address,
      currency1: currency1 as Address,
      fee:         500,
      tickSpacing: 10,
      hooks:       "0x0000000000000000000000000000000000000000",
    };
  }

  private async getQuoteExact(
    poolKey: PoolKey,
    amountIn: bigint,
    chainId: number
  ): Promise<bigint> {
    // Stub return for illustration
    return (amountIn * 98n) / 100n;
  }

  private encodeSwapCalldata(
    poolKey: PoolKey,
    amountIn: bigint,
    amountOut: bigint,
    slippageBps: number,
    recipient: Address,
    deadline: number
  ): Hex {
    const minOut = amountIn * BigInt(10000 - slippageBps) / 10000n;

    // Encode exact input single params
    const exactInputSingleParams = encodeAbiParameters(
      [
        { type: "tuple", components: [
          { name: "poolKey",            type: "tuple", components: [
            { name: "currency0",   type: "address" },
            { name: "currency1",   type: "address" },
            { name: "fee",         type: "uint24"  },
            { name: "tickSpacing", type: "int24"   },
            { name: "hooks",       type: "address" },
          ]},
          { name: "zeroForOne",         type: "bool"    },
          { name: "amountIn",           type: "uint128" },
          { name: "amountOutMinimum",   type: "uint128" },
          { name: "hookData",           type: "bytes"   },
        ]},
      ],
      [{
        poolKey: {
          currency0: poolKey.currency0,
          currency1: poolKey.currency1,
          fee:         poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
          hooks:       poolKey.hooks,
        },
        zeroForOne:        BigInt(poolKey.currency0) < BigInt(poolKey.currency1),
        amountIn:          amountIn,
        amountOutMinimum:  minOut,
        hookData:          "0x",
      }]
    );

    // Encode settle and take
    const settleParams = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [poolKey.currency0, amountIn]
    );

    const takeParams = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [poolKey.currency1, minOut]
    );

    // Actions
    const actions = `0x060c0f`; // SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL

    // Encode into a single inputs array
    const inputs = encodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes[]" }],
      [actions as Hex, [exactInputSingleParams, settleParams, takeParams]]
    );

    return encodeFunctionData({
      abi: UniversalRouterABI,
      functionName: "execute",
      args: [
        "0x10", // V4_SWAP command
        [inputs],
        BigInt(deadline),
      ],
    });
  }

  private async estimateGas(_chainId: number, _calldata: Hex): Promise<bigint> {
    return 130_000n * 2_000_000_000n;
  }

  private async getPriceImpact(
    _poolKey: PoolKey,
    _amountIn: bigint,
    _amountOut: bigint,
    _chainId: number
  ): Promise<number> {
    return 30; // 0.3% stub
  }

  private isNativeETH(addr: Address): boolean {
    return addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" || addr === "0x0000000000000000000000000000000000000000";
  }
}
