import { type Address, type Hex, type Chain } from "viem";

// ─── Input ────────────────────────────────────────────────────────────────────

export interface SwapIntent {
  /** Token to sell — address or well-known symbol ("ETH", "USDC") */
  fromToken: Address | string;
  /** Token to buy */
  toToken: Address | string;
  /** Amount to sell, in token's native units (e.g. 1 ETH = "1000000000000000000") */
  fromAmount: bigint;
  /** Source chain ID */
  fromChainId: number;
  /** Destination chain ID — omit for same-chain swap */
  toChainId?: number;
  /** Max slippage as basis points (e.g. 50 = 0.5%). Default: 50 */
  maxSlippageBps?: number;
  /** Unix timestamp deadline. Default: now + 20min */
  deadline?: number;
  /** Which protocols to try. Default: all */
  protocols?: SwapProtocol[];
  /** Skip MEV simulation (faster but unprotected). Default: false */
  skipMEVCheck?: boolean;
  /** Recipient of output tokens. Default: signer address */
  recipient?: Address;
}

export type SwapProtocol = "uniswap-v4" | "1inch-fusion" | "paraswap";

// ─── Quote ────────────────────────────────────────────────────────────────────

export interface QuoteResult {
  protocol: SwapProtocol;
  /** Amount of toToken received, before gas/MEV */
  amountOut: bigint;
  /** Estimated gas cost in ETH (wei) */
  gasCostWei: bigint;
  /** MEV exposure estimate in toToken units (0 if unknown) */
  mevExposure: bigint;
  /** Net output = amountOut - mevExposure (what user actually gets) */
  netAmountOut: bigint;
  /** Price impact in basis points */
  priceImpactBps: number;
  /** Protocol-specific route data needed for execution */
  routeData: UniswapV4RouteData | OneInchRouteData | ParaswapRouteData;
  /** Unix timestamp when this quote expires */
  validUntil: number;
}

export interface UniswapV4RouteData {
  type: "uniswap-v4";
  poolKey: PoolKey;
  hookData: Hex;
  sqrtPriceLimitX96: bigint;
  calldata: Hex; // pre-encoded UniversalRouter calldata
}

export interface OneInchRouteData {
  type: "1inch-fusion";
  orderHash: Hex;
  order: FusionOrderStruct;
  secrets: Hex[]; // HTLC secrets for cross-chain
}

export interface ParaswapRouteData {
  type: "paraswap";
  priceRoute: unknown; // Paraswap's opaque priceRoute object
  calldata: Hex;
}

// ─── Uniswap V4 primitives ────────────────────────────────────────────────────

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;       // pool fee in pips (e.g. 3000 = 0.3%)
  tickSpacing: number;
  hooks: Address;    // hook contract address (0x0 if no hook)
}

export interface FusionOrderStruct {
  salt: bigint;
  maker: Address;
  receiver: Address;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: bigint;
  takingAmount: bigint;
  makerTraits: bigint;
}

// ─── Execution ────────────────────────────────────────────────────────────────

export interface SwapResult {
  txHash: Hex;
  protocol: SwapProtocol;
  actualAmountOut: bigint;
  gasPaidWei: bigint;
  mevExtractedWei: bigint;
  route: QuoteResult;
  /** Block timestamp of inclusion */
  confirmedAt?: number;
}

// ─── MEV ─────────────────────────────────────────────────────────────────────

export interface MEVReport {
  sandwichRisk: "none" | "low" | "medium" | "high";
  estimatedMEVWei: bigint;
  /** Recommended slippage to set given current mempool conditions */
  recommendedSlippageBps: number;
  /** Detected sandwich bots targeting this pool */
  detectedBots: Address[];
}
