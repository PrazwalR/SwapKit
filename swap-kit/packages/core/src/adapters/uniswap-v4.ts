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
}> = {
  1: {
    poolManager:     "0x000000000004444c5dc75cB358380D2e3dE08A90",
    universalRouter: "0x66a9893cC07D91D95644AEBB9316da448A68a0F5",
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    stateView:       "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597ea0",
  },
  8453: { // Base
    poolManager:     "0x498581fF718922c3f8e6A244956aF099B2652b2B",
    universalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    stateView:       "0x9a9Ba3fc3F26A4EFA20e05eFbfE70dFc4696dC4e",
  },
  42161: { // Arbitrum
    poolManager:     "0x360E68faCcca9F7aD11B8c6eeB46d5E39c35cB23",
    universalRouter: "0xa51afb6a2936c1a3c0b3fc3f6011b7b56a8ba0b7",
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    stateView:       "0x6Fb1f7aC54D93B86Ea1F99E67b8C1Df3DdF07f4f",
  },
};

// Key v4 concept: Commands for UniversalRouter
// https://docs.uniswap.org/contracts/v4/reference/periphery/UniversalRouter
const V4_SWAP_COMMAND = 0x10; // V4_SWAP command

export class UniswapV4Adapter implements ISwapAdapter {
  readonly protocol = "uniswap-v4" as const;

  supports(intent: Required<SwapIntent>): boolean {
    // v4 is deployed on these chains
    const supported = [1, 8453, 42161, 10, 137, 56, 81457];
    return (
      supported.includes(intent.fromChainId) &&
      intent.fromChainId === intent.toChainId // v4 is single-chain (use bridges for cross-chain)
    );
  }

  async quote(intent: Required<SwapIntent>): Promise<QuoteResult> {
    const addrs = UNISWAP_V4_ADDRESSES[intent.fromChainId];
    if (!addrs) throw new Error(`Uniswap v4 not deployed on chain ${intent.fromChainId}`);

    // Step 1: Find the best pool for this pair
    // In v4, a pool is identified by its PoolKey (currency0, currency1, fee, tickSpacing, hooks)
    // We try the most common fee tiers: 100, 500, 3000, 10000 pips
    const poolKey = await this.findBestPool(
      intent.fromToken as Address,
      intent.toToken as Address,
      intent.fromChainId
    );

    // Step 2: Get quote via Quoter contract (off-chain simulation)
    // v4 uses QuoterV2 which simulates a swap and reverts with the result
    const amountOut = await this.getQuoteExact(
      poolKey,
      intent.fromAmount,
      intent.fromChainId
    );

    // Step 3: Encode UniversalRouter calldata
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
      mevExposure:    0n, // filled in by MEVGuard
      netAmountOut:   amountOut - gasCostWei, // rough pre-MEV estimate
      priceImpactBps: await this.getPriceImpact(poolKey, intent.fromAmount, amountOut, intent.fromChainId),
      routeData: {
        type:              "uniswap-v4",
        poolKey,
        hookData:          "0x",
        sqrtPriceLimitX96: 0n,
        calldata,
      },
      validUntil: Math.floor(Date.now() / 1000) + 30, // quote valid 30s
    };
  }

  async execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const routeData = quote.routeData as UniswapV4RouteData;
    const addrs = UNISWAP_V4_ADDRESSES[walletClient.chain!.id];

    // Approve Permit2 first if needed (ERC-20 only, not ETH)
    // Permit2 is a universal approval contract — one approval unlocks all Uniswap contracts
    // This is idempotent if already approved

    const txHash = await walletClient.sendTransaction({
      account: walletClient.account!,
      chain:   walletClient.chain!,
      to:      addrs.universalRouter,
      data:    routeData.calldata,
      value:   0n, // For ETH swaps, caller should set value externally
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    return {
      txHash,
      protocol:          "uniswap-v4",
      actualAmountOut:   quote.amountOut, // parse from logs for accuracy
      gasPaidWei:        receipt.gasUsed * receipt.effectiveGasPrice,
      mevExtractedWei:   0n,
      route:             quote,
      confirmedAt:       Math.floor(Date.now() / 1000),
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async findBestPool(
    token0: Address,
    token1: Address,
    chainId: number
  ): Promise<PoolKey> {
    // Sort tokens: currency0 < currency1 (Uniswap convention)
    const [currency0, currency1] = BigInt(token0) < BigInt(token1)
      ? [token0, token1]
      : [token1, token0];

    // Try fee tiers in order of typical liquidity
    // const feeTiers = [500, 3000, 100, 10000];
    // const tickSpacings: Record<number, number> = {
    //   100:   1,
    //   500:   10,
    //   3000:  60,
    //   10000: 200,
    // };

    // In production: query StateView contract to check which pools have liquidity
    // For now, return 500 pip (0.05%) as default — most liquid for major pairs
    return {
      currency0,
      currency1,
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
    // Call QuoterV2 contract
    // QuoterV2 simulates the swap by calling PoolManager.swap() and catching the revert
    // The revert data contains the amountOut
    // This is a standard pattern in Uniswap v4
    //
    // In production, use viem's simulateContract:
    // const result = await publicClient.simulateContract({
    //   address: QUOTER_V2_ADDRESS,
    //   abi: QuoterV2ABI,
    //   functionName: "quoteExactInputSingle",
    //   args: [{ poolKey, zeroForOne: true, exactAmount: amountIn, sqrtPriceLimitX96: 0n, hookData: "0x" }]
    // });
    //
    // Stub return for illustration:
    return (amountIn * 98n) / 100n; // 2% price impact stub
  }

  private encodeSwapCalldata(
    poolKey: PoolKey,
    amountIn: bigint,
    _amountOutMin: bigint,
    slippageBps: number,
    _recipient: Address,
    deadline: number
  ): Hex {
    // UniversalRouter in v4 uses a command + input encoding pattern
    // Commands are bytes: each byte is one action
    // 0x10 = V4_SWAP
    //
    // The actions within V4_SWAP:
    // SWAP_EXACT_IN_SINGLE = 0x06
    // SETTLE_ALL           = 0x0c
    // TAKE_ALL             = 0x0f
    //
    // This is the actual encoding you need:
    const minOut = amountIn * BigInt(10000 - slippageBps) / 10000n;

    // Encode the V4 swap parameters
    const swapParams = encodeAbiParameters(
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
          { name: "sqrtPriceLimitX96",  type: "uint160" },
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
        sqrtPriceLimitX96: 0n,
        hookData:          "0x",
      }]
    );

    // encodeFunctionData for UniversalRouter.execute(bytes commands, bytes[] inputs, uint256 deadline)
    // See: https://docs.uniswap.org/contracts/v4/reference/periphery/UniversalRouter
    return encodeFunctionData({
      abi: UniversalRouterABI,
      functionName: "execute",
      args: [
        "0x10",  // V4_SWAP command
        [swapParams],
        BigInt(deadline),
      ],
    });
  }

  private async estimateGas(_chainId: number, _calldata: Hex): Promise<bigint> {
    // Uniswap v4's gas is ~30% lower than v3 due to singleton + flash accounting
    // Typical: ~130,000 gas for single-hop ETH/USDC
    return 130_000n * 2_000_000_000n; // 130k gas @ 2 gwei — stub
  }

  private async getPriceImpact(
    _poolKey: PoolKey,
    _amountIn: bigint,
    _amountOut: bigint,
    _chainId: number
  ): Promise<number> {
    // Price impact = (spotPrice - executionPrice) / spotPrice
    // In production, query PoolManager for slot0 (sqrtPriceX96) to get spot price
    return 30; // 0.3% stub
  }

  private isNativeETH(addr: Address): boolean {
    return addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  }
}
