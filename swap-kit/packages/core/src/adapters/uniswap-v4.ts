import {
  createPublicClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  type Address,
  type Hex,
  type WalletClient,
  type PublicClient,
} from "viem";
import { mainnet, base, arbitrum } from "viem/chains";
import { UniversalRouterABI } from "../abis/index.js";
import { isNativeToken } from "../utils/token.js";
import { ERC20ABI } from "../abis/index.js";
import type { ISwapAdapter } from "./base.js";
import type {
  SwapIntent,
  QuoteResult,
  SwapResult,
  PoolKey,
  UniswapV4RouteData,
} from "../types.js";
import { getPublicClient } from "../utils/chain.js";
import { assertValidSlippageBps } from "../intent/parser.js";

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



const CHAINS: Record<number, any> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
};

// Quoter ABI (only the function we need)
const QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: [
            { name: "currency0",   type: "address" },
            { name: "currency1",   type: "address" },
            { name: "fee",         type: "uint24"  },
            { name: "tickSpacing", type: "int24"   },
            { name: "hooks",       type: "address" },
          ]},
          { name: "zeroForOne",       type: "bool"    },
          { name: "exactAmount",      type: "uint128" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
          { name: "hookData",         type: "bytes"   },
        ],
      },
    ],
    outputs: [
      { name: "amountOut",      type: "int128[]" },
      { name: "sqrtPriceX96After", type: "uint160[]" },
      { name: "initializedTicksCrossed", type: "uint32" },
    ],
  },
] as const;

// V4 Router Actions
const ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL:           0x0c,
  TAKE_ALL:             0x0f,
};

export class UniswapV4Adapter implements ISwapAdapter {
  readonly protocol = "uniswap-v4" as const;

  supports(intent: Required<SwapIntent>): boolean {
    return intent.fromChainId === intent.toChainId && !!UNISWAP_V4_ADDRESSES[intent.fromChainId];
  }

  async quote(intent: Required<SwapIntent>): Promise<QuoteResult> {
    // Defense-in-depth: reject unsafe slippage before it reaches minOut math.
    assertValidSlippageBps(intent.maxSlippageBps);

    const addrs = UNISWAP_V4_ADDRESSES[intent.fromChainId];
    if (!addrs) throw new Error(`Uniswap v4 not deployed on chain ${intent.fromChainId}`);

    const client = getPublicClient(intent.fromChainId);

    const fees = [100, 500, 3000, 10000];
    let bestAmountOut = 0n;
    let bestPoolKey: PoolKey | null = null;

    // Test multiple fee tiers to find the pool with the best liquidity (CRITICAL-3)
    for (const fee of fees) {
      const poolKey = this.buildPoolKey(intent.fromToken as Address, intent.toToken as Address, fee);
      try {
        const amountOut = await this.getQuoteExact(client, poolKey, intent.fromAmount, addrs.quoter, intent.fromToken as Address);
        if (amountOut > bestAmountOut) {
          bestAmountOut = amountOut;
          bestPoolKey = poolKey;
        }
      } catch {
        // Pool doesn't exist or not enough liquidity, try next fee tier
      }
    }

    if (!bestPoolKey || bestAmountOut === 0n) {
      // HIGH-6: Throw instead of returning fake DefiLlama estimate
      throw new Error(`No Uniswap V4 pool found with sufficient liquidity for this pair`);
    }

    const fromNormalized = this.isNativeETH(intent.fromToken as Address)
      ? "0x0000000000000000000000000000000000000000" as Address
      : intent.fromToken as Address;
    const zeroForOne = fromNormalized.toLowerCase() === bestPoolKey.currency0.toLowerCase();

    const calldata = this.encodeSwapCalldata(
      bestPoolKey,
      intent.fromAmount,
      bestAmountOut,
      intent.maxSlippageBps,
      intent.deadline,
      zeroForOne
    );

    const gasCostWei = await this.estimateGas(client, calldata);
    const priceImpactBps = await this.getPriceImpact(intent.fromToken as Address, intent.toToken as Address, intent.fromAmount, bestAmountOut, intent.fromChainId);

    return {
      protocol:       "uniswap-v4",
      amountOut:      bestAmountOut,
      gasCostWei,
      mevExposure:    0n,
      netAmountOut:   bestAmountOut,
      priceImpactBps,
      routeData: {
        type:              "uniswap-v4",
        poolKey:           bestPoolKey,
        hookData:          "0x",
        sqrtPriceLimitX96: 0n,
        calldata,
        fromAmount:        intent.fromAmount, // Carry input amount for native ETH value
        fromToken:         intent.fromToken,  // Carry tokens for balance measurement
        toToken:           intent.toToken,
      },
      validUntil: Math.floor(Date.now() / 1000) + 30,
    };
  }

  async execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const routeData = quote.routeData as any;
    const addrs = UNISWAP_V4_ADDRESSES[walletClient.chain!.id];
    const userAddress = walletClient.account!.address;

    // Determine if input token is native ETH — use the actual fromAmount, not a missing field
    const fromToken = routeData.fromToken as string ?? "";
    const toToken = routeData.toToken as string ?? "";
    const isNativeIn = this.isNativeETH(fromToken as Address);
    const value = isNativeIn ? BigInt(routeData.fromAmount ?? 0) : 0n;

    // Measure balance BEFORE swap for accurate output measurement
    const isDstNative = this.isNativeETH(toToken as Address);
    const balanceBefore = isDstNative
      ? await publicClient.getBalance({ address: userAddress })
      : await publicClient.readContract({
          address: toToken as Address,
          abi: ERC20ABI,
          functionName: "balanceOf",
          args: [userAddress],
        }) as bigint;

    const txHash = await walletClient.sendTransaction({
      account: walletClient.account!,
      chain:   walletClient.chain!,
      to:      addrs.universalRouter,
      data:    routeData.calldata,
      value,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Measure balance AFTER swap
    const balanceAfter = isDstNative
      ? await publicClient.getBalance({ address: userAddress })
      : await publicClient.readContract({
          address: toToken as Address,
          abi: ERC20ABI,
          functionName: "balanceOf",
          args: [userAddress],
        }) as bigint;

    const actualAmountOut = balanceAfter - balanceBefore;
    const mevExtractedWei = quote.amountOut > actualAmountOut
      ? quote.amountOut - actualAmountOut
      : 0n;

    return {
      txHash,
      protocol:          "uniswap-v4",
      actualAmountOut,
      gasPaidWei:        receipt.gasUsed * receipt.effectiveGasPrice,
      mevExtractedWei,
      route:             quote,
      confirmedAt:       Math.floor(Date.now() / 1000),
    };
  }

  private buildPoolKey(
    token0: Address,
    token1: Address,
    fee: number
  ): PoolKey {
    const t0 = this.isNativeETH(token0) ? "0x0000000000000000000000000000000000000000" : token0;
    const t1 = this.isNativeETH(token1) ? "0x0000000000000000000000000000000000000000" : token1;

    const [currency0, currency1] = BigInt(t0) < BigInt(t1) ? [t0, t1] : [t1, t0];

    return {
      currency0: currency0 as Address,
      currency1: currency1 as Address,
      fee,
      tickSpacing: fee === 100 ? 1 : fee === 500 ? 10 : fee === 3000 ? 60 : 200,
      hooks: "0x0000000000000000000000000000000000000000",
    };
  }

  private async getQuoteExact(
    client: any,
    poolKey: PoolKey,
    amountIn: bigint,
    quoterAddr: Address,
    fromToken: Address
  ): Promise<bigint> {
    const fromNormalized = this.isNativeETH(fromToken)
      ? "0x0000000000000000000000000000000000000000" as Address
      : fromToken;
    const zeroForOne = fromNormalized.toLowerCase() === poolKey.currency0.toLowerCase();

    const result = await client.simulateContract({
      address: quoterAddr,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{
        poolKey: {
          currency0: poolKey.currency0,
          currency1: poolKey.currency1,
          fee:       poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
          hooks:     poolKey.hooks,
        },
        zeroForOne,
        exactAmount: amountIn,
        sqrtPriceLimitX96: 0n,
        hookData: "0x",
      }],
    });

    const amountOutArray = result.result[0] as bigint[];
    const rawOut = amountOutArray[0];
    return rawOut < 0n ? -rawOut : rawOut;
  }

  private async getPriceImpact(
    fromToken: Address,
    toToken: Address,
    amountIn: bigint,
    amountOut: bigint,
    chainId: number
  ): Promise<number> {
    const chainName: Record<number, string> = { 1: "ethereum", 8453: "base", 42161: "arbitrum" };
    const chain = chainName[chainId] || "ethereum";

    const srcAddr = this.isNativeETH(fromToken) ? "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" : fromToken;
    const dstAddr = this.isNativeETH(toToken) ? "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" : toToken;

    try {
      const coins = `${chain}:${srcAddr},${chain}:${dstAddr}`;
      const res = await fetch(`https://coins.llama.fi/prices/current/${coins}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return 30; // default to 0.3% on API failure

      const data = await res.json() as any;
      const srcKey = Object.keys(data.coins).find(k => k.toLowerCase().includes(srcAddr.toLowerCase().slice(0, 10)));
      const dstKey = Object.keys(data.coins).find(k => k.toLowerCase().includes(dstAddr.toLowerCase().slice(0, 10)));
      if (!srcKey || !dstKey) return 30;

      const srcPrice = data.coins[srcKey].price as number;
      const dstPrice = data.coins[dstKey].price as number;
      const srcDecimals = data.coins[srcKey].decimals as number;
      const dstDecimals = data.coins[dstKey].decimals as number;

      const srcAmount = Number(amountIn) / (10 ** srcDecimals);
      const usdValue = srcAmount * srcPrice;
      const expectedDstAmount = usdValue / dstPrice;
      const actualDstAmount = Number(amountOut) / (10 ** dstDecimals);

      if (expectedDstAmount <= 0) return 0;
      
      const impact = (expectedDstAmount - actualDstAmount) / expectedDstAmount;
      const impactBps = Math.round(impact * 10000);
      return Math.max(0, impactBps);
    } catch {
      return 30;
    }
  }

  // NOTE: The encoded route settles via TAKE_ALL, which delivers the output to
  // msgSender (the signer) — there is no recipient parameter here by design. A
  // custom recipient is rejected upstream in ExecutionEngine.execute().
  private encodeSwapCalldata(
    poolKey: PoolKey,
    amountIn: bigint,
    amountOut: bigint,
    slippageBps: number,
    deadline: number,
    zeroForOne: boolean
  ): Hex {
    const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;
    const settleCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
    const takeCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;

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
        zeroForOne,
        amountIn:          amountIn,
        amountOutMinimum:  minOut,
        hookData:          "0x",
      }]
    );

    // Encode settle and take
    const settleParams = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [settleCurrency, amountIn]
    );

    const takeParams = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [takeCurrency, minOut]
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

  private async estimateGas(client: any, _calldata: Hex): Promise<bigint> {
    try {
      const gasPrice = await client.getGasPrice();
      // Uniswap V4 swaps take roughly 150k-200k gas depending on tick crossing
      return gasPrice * 180_000n;
    } catch {
      // Chain-aware fallback gas prices
      const chainId = client.chain?.id ?? 1;
      const fallbackGwei: Record<number, bigint> = {
        1:     20_000_000_000n,   // Ethereum: ~20 gwei
        8453:  10_000_000n,       // Base: ~0.01 gwei
        42161: 100_000_000n,      // Arbitrum: ~0.1 gwei
        10:    10_000_000n,       // Optimism: ~0.01 gwei
        137:   30_000_000_000n,   // Polygon: ~30 gwei
        56:    3_000_000_000n,    // BSC: ~3 gwei
      };
      return 180_000n * (fallbackGwei[chainId] ?? 20_000_000_000n);
    }
  }

  private isNativeETH(addr: Address): boolean {
    return addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" || addr === "0x0000000000000000000000000000000000000000";
  }
}
