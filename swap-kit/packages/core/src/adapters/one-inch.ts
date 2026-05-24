import { SDK, NetworkEnum, HashLock, PrivateKeyProviderConnector } from "@1inch/cross-chain-sdk";
import type { ISwapAdapter } from "./base.js";
import type { SwapIntent, QuoteResult, SwapResult, OneInchRouteData } from "../types.js";
import type { WalletClient, PublicClient, Hex } from "viem";

// Supported chain IDs and their NetworkEnum equivalents
const CHAIN_TO_NETWORK: Record<number, NetworkEnum> = {
  1:     NetworkEnum.ETHEREUM,
  8453:  NetworkEnum.BASE,
  42161: NetworkEnum.ARBITRUM,
  137:   NetworkEnum.POLYGON,
  56:    NetworkEnum.BSC,
};

export class OneInchFusionAdapter implements ISwapAdapter {
  readonly protocol = "1inch-fusion" as const;
  private sdk: SDK;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    // SDK is initialized per-execution with the signer's connector
    // Here we create a "read-only" SDK for quotes
    this.sdk = new SDK({
      url: "https://api.1inch.dev/fusion-plus",
      authKey: apiKey,
      // No blockchain provider needed for quote-only
    });
  }

  supports(intent: Required<SwapIntent>): boolean {
    const supportedChains = Object.keys(CHAIN_TO_NETWORK).map(Number);
    return (
      supportedChains.includes(intent.fromChainId) &&
      supportedChains.includes(intent.toChainId)
    );
  }

  async quote(intent: Required<SwapIntent>): Promise<QuoteResult> {
    const srcChain = CHAIN_TO_NETWORK[intent.fromChainId];
    const dstChain = CHAIN_TO_NETWORK[intent.toChainId];

    // 1inch Fusion+ quote API
    // For cross-chain: uses HTLC (Hash Time-Locked Contracts) with secrets
    // For same-chain: uses standard Fusion mode (off-chain order matching)
    const quoteParams = {
      srcChainId:    srcChain,
      dstChainId:    dstChain,
      srcTokenAddress: intent.fromToken as string,
      dstTokenAddress: intent.toToken as string,
      amount:          intent.fromAmount.toString(),
      walletAddress:   "0x0000000000000000000000000000000000000001", // placeholder for quotes
      enableEstimate:  true,
    };

    const quote = await this.sdk.getQuote(quoteParams);
    const amountOut = BigInt(quote.dstTokenAmount ?? "0");

    return {
      protocol:       "1inch-fusion",
      amountOut,
      gasCostWei:     0n, // Fusion+ is gasless for the user (resolver pays gas)
      mevExposure:    0n, // Fusion+ is MEV-protected by design (private order flow)
      netAmountOut:   amountOut, // No gas cost = full amount
      priceImpactBps: Math.round((quote.prices?.usd?.srcToken ?? 0) * 100),
      routeData: {
        type:      "1inch-fusion",
        orderHash: "0x" as Hex,  // filled during execute
        order:     {} as any,    // filled during execute
        secrets:   [],           // filled during execute
      },
      validUntil: Math.floor(Date.now() / 1000) + 120, // Fusion+ quotes valid 2min
    };
  }

  async execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const chainId = walletClient.chain!.id;
    const network = CHAIN_TO_NETWORK[chainId];

    // Create SDK with the actual signer
    const connector = new PrivateKeyProviderConnector(
      "PRIVATE_KEY_FROM_WALLET", // In production: use walletClient.signTypedData
      publicClient as any
    );

    const sdk = new SDK({
      url: "https://api.1inch.dev/fusion-plus",
      authKey: this.apiKey,
      blockchainProvider: connector,
    });

    // Generate HTLC secrets (required for cross-chain Fusion+ orders)
    // Secrets are random bytes that act as the preimage for the hash lock
    const secretsCount = 3; // More secrets = more fillable partial amounts
    const secrets = Array.from({ length: secretsCount }, () =>
      HashLock.fromString(
        Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
      )
    );
    const secretHashes = secrets.map(s => s.toString());
    const hashLock = secretsCount === 1
      ? HashLock.forSingleFill(secrets[0])
      : HashLock.forMultipleFills(secrets.map((s, i) => ({ secret: s, idx: i })));

    // Place the order
    const order = await sdk.placeOrder({
      srcChainId:      CHAIN_TO_NETWORK[chainId],
      dstChainId:      CHAIN_TO_NETWORK[quote.route?.fromChainId ?? chainId],
      srcTokenAddress: "...", // from intent
      dstTokenAddress: "...", // from intent
      amount:          "...", // from intent
      walletAddress:   walletClient.account!.address,
      hashLock,
      secretHashes,
    });

    // Poll for fill status
    // Resolvers have up to 2 minutes to fill the order
    let filled = false;
    const orderHash = order.orderHash as Hex;

    for (let i = 0; i < 24; i++) { // Poll every 5s for 2min
      await new Promise(r => setTimeout(r, 5000));
      const status = await sdk.getOrderStatus(orderHash);
      if (status.status === "Filled") { filled = true; break; }
      if (status.status === "Cancelled") throw new Error("Order cancelled by resolver");
    }

    if (!filled) throw new Error("Order not filled within timeout");

    return {
      txHash:          orderHash,
      protocol:        "1inch-fusion",
      actualAmountOut: quote.amountOut,
      gasPaidWei:      0n, // gasless
      mevExtractedWei: 0n,
      route:           quote,
      confirmedAt:     Math.floor(Date.now() / 1000),
    };
  }
}
