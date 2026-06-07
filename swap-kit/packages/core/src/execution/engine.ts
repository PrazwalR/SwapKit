import { type WalletClient, type PublicClient, type Address, type Hex, createWalletClient, http } from "viem";
import type { SwapIntent, QuoteResult, SwapResult, SwapProtocol, GaslessConfig } from "../types.js";
import type { ISwapAdapter } from "../adapters/base.js";
import { ERC20ABI, Permit2ABI } from "../abis/index.js";
import { isNativeToken } from "../utils/token.js";
import { checkGasAffordability, type GasCheck } from "../gasless/detector.js";

// Permit2 is deployed at the same address on all chains
const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Max uint256 for unlimited approval
const MAX_UINT256 = 2n ** 256n - 1n;

// Default Flashbots Protect RPC endpoint (Ethereum Mainnet)
const DEFAULT_FLASHBOTS_RPC = "https://rpc.flashbots.net";

/**
 * How much allowance to grant when approving a token to a router/spender.
 * - `"exact"`    — approve only the amount needed for this swap (safest; default).
 *                  Limits loss to the current trade if the spender is ever exploited.
 * - `"infinite"` — approve MAX_UINT256 once (saves gas on repeat swaps, but the
 *                  spender can move the entire balance forever).
 */
export type ApprovalStrategy = "exact" | "infinite";

export interface ExecutionEngineConfig {
  /** Auto-approve tokens before swapping. Default: true */
  autoApprove?: boolean;
  /** Use Permit2 for approvals (Uniswap). Default: true */
  usePermit2?: boolean;
  /** Allowance amount strategy for ERC-20 approvals. Default: "exact" */
  approvalStrategy?: ApprovalStrategy;
  /** Enable automatic Flashbots Protect rerouting on high MEV risk. Default: true */
  flashbotsEnabled?: boolean;
  /**
   * Fail-safe: also reroute through Flashbots Protect when MEV risk is "unknown"
   * (i.e. the MEV engine was unreachable/slow, or returned an unparseable result).
   * Without this, a down or compromised MEV engine silently disables protection.
   * Default: false — only enable on Ethereum mainnet, where the Flashbots Protect
   * RPC is valid (rerouting an L2 swap to a mainnet RPC would break it).
   */
  flashbotsRerouteOnUnknownRisk?: boolean;
  /** Custom Flashbots Protect RPC URL. Default: https://rpc.flashbots.net */
  flashbotsProtectRpc?: string;
  /** Callback fired when a transaction is rerouted through Flashbots Protect */
  onFlashbotsReroute?: (quote: QuoteResult) => void;
  /** Gasless swap configuration (EIP-4337 Account Abstraction) */
  gasless?: GaslessConfig;
}

/**
 * ExecutionEngine handles the full lifecycle of a swap:
 * 1. Check & set token approvals (ERC-20 approve or Permit2)
 * 2. Submit the transaction via the appropriate adapter
 * 3. Wait for confirmation and parse the receipt
 */
export class ExecutionEngine {
  private adapters: Map<SwapProtocol, ISwapAdapter>;
  private config: {
    autoApprove: boolean;
    usePermit2: boolean;
    approvalStrategy: ApprovalStrategy;
    flashbotsEnabled: boolean;
    flashbotsRerouteOnUnknownRisk: boolean;
    flashbotsProtectRpc: string;
    onFlashbotsReroute: ((quote: QuoteResult) => void) | null;
    gasless: {
      enabled: boolean;
      paymasterUrl: string | null;
      onGaslessSwap: ((gasCheck: GasCheck) => void) | null;
    };
  };

  constructor(
    adapters: ISwapAdapter[],
    config: ExecutionEngineConfig = {}
  ) {
    this.adapters = new Map(
      adapters.map(a => [a.protocol as SwapProtocol, a])
    );
    this.config = {
      autoApprove:        config.autoApprove ?? true,
      usePermit2:         config.usePermit2 ?? true,
      approvalStrategy:   config.approvalStrategy ?? "exact",
      flashbotsEnabled:   config.flashbotsEnabled ?? true,
      flashbotsRerouteOnUnknownRisk: config.flashbotsRerouteOnUnknownRisk ?? false,
      flashbotsProtectRpc: config.flashbotsProtectRpc ?? DEFAULT_FLASHBOTS_RPC,
      onFlashbotsReroute: config.onFlashbotsReroute ?? null,
      gasless: {
        enabled:       config.gasless?.enabled ?? false,
        paymasterUrl:  config.gasless?.paymasterUrl ?? null,
        onGaslessSwap: config.gasless?.onGaslessSwap ?? null,
      },
    };
  }

  /**
   * Execute a swap using the given quote.
   * Handles approvals automatically if configured.
   */
  async execute(
    intent: Required<SwapIntent>,
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<SwapResult> {
    const adapter = this.adapters.get(quote.protocol);
    if (!adapter) {
      throw new Error(`No adapter found for protocol: ${quote.protocol}`);
    }

    // 🎯 RECIPIENT SAFETY CHECK
    // Every adapter delivers swap output to the signer (Uniswap v4 settles via
    // TAKE_ALL → msgSender; 1inch/Paraswap use the signer as `from`/receiver).
    // A custom recipient is NOT honored, so rather than silently misrouting funds
    // to the signer we reject loudly. (Security audit: v4 `recipient` was ignored.)
    const signer = walletClient.account?.address;
    if (
      signer &&
      intent.recipient &&
      intent.recipient !== "0x0000000000000000000000000000000000000000" &&
      intent.recipient.toLowerCase() !== signer.toLowerCase()
    ) {
      throw new Error(
        `Custom recipient is not supported: swap output is delivered to the signer ` +
        `(${signer}), but intent.recipient is ${intent.recipient}. Omit recipient ` +
        `(or set it to the signer) and transfer the output separately.`
      );
    }

    // 🛡️ FLASHBOTS PROTECT INTERCEPTOR
    // Reroute on confirmed high risk, and — when the fail-safe is enabled — also
    // when risk is "unknown" (engine down/slow/compromised). The latter is opt-in
    // so we don't reroute every swap to a mainnet RPC when no engine is configured.
    let executionWalletClient = walletClient;
    const isHighRisk = quote.sandwichRisk === "high";
    const isUnknownRisk = quote.sandwichRisk === "unknown";
    const shouldReroute =
      this.config.flashbotsEnabled &&
      (isHighRisk || (this.config.flashbotsRerouteOnUnknownRisk && isUnknownRisk));

    if (shouldReroute) {
      console.log(
        isHighRisk
          ? "🛡️ High MEV risk detected! Rerouting transaction to Flashbots Protect RPC..."
          : "🛡️ MEV risk could not be assessed (fail-safe) — rerouting to Flashbots Protect RPC..."
      );
      executionWalletClient = createWalletClient({
        account: walletClient.account!,
        chain: walletClient.chain!,
        transport: http(this.config.flashbotsProtectRpc)
      });

      // Fire the developer callback if registered (wrapped in try/catch
      // so a crashing callback can never take down the swap pipeline)
      if (this.config.onFlashbotsReroute) {
        try {
          this.config.onFlashbotsReroute(quote);
        } catch (err) {
          console.warn("⚠️ onFlashbotsReroute callback threw:", err);
        }
      }
    }

    // ⛽ GASLESS SWAP INTERCEPTOR (EIP-4337)
    if (this.config.gasless.enabled) {
      const gasCheck = await checkGasAffordability(executionWalletClient, publicClient, quote);

      if (!gasCheck.canAffordGas) {
        console.log(
          `⛽ Gasless mode: User is short by ${gasCheck.shortfallWei} wei ` +
          `(balance: ${gasCheck.userBalanceWei}, needed: ${gasCheck.estimatedGasCostWei})`
        );

        // Fire the developer callback if registered
        if (this.config.gasless.onGaslessSwap) {
          try {
            this.config.gasless.onGaslessSwap(gasCheck);
          } catch (err) {
            console.warn("⚠️ onGaslessSwap callback threw:", err);
          }
        }

        // For now, throw a descriptive error until Paymaster integration is complete
        throw new Error(
          `Insufficient gas: user has ${gasCheck.userBalanceWei} wei but needs ` +
          `${gasCheck.estimatedGasCostWei} wei. Gasless execution via Paymaster ` +
          `is not yet available. Configure a paymasterUrl in the next release.`
        );
      }
    }

    // Step 1: Handle token approvals (skip for native ETH and gasless cross-chain Fusion+ orders)
    const isFusionGasless = quote.protocol === "1inch-fusion" && 
      (quote.routeData as any)?.order?.srcChainId && 
      (quote.routeData as any)?.order?.dstChainId &&
      (quote.routeData as any).order.srcChainId !== (quote.routeData as any).order.dstChainId;

    if (
      this.config.autoApprove &&
      !isNativeToken(intent.fromToken as string) &&
      !isFusionGasless
    ) {
      await this.ensureApproval(
        intent.fromToken as Address,
        intent.fromAmount,
        quote,
        executionWalletClient,
        publicClient
      );
    }

    // Step 2: Execute the swap via adapter
    return adapter.execute(quote, executionWalletClient, publicClient);
  }

  /**
   * Returns the adapter for a given protocol.
   */
  getAdapter(protocol: SwapProtocol): ISwapAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) {
      throw new Error(`No adapter registered for protocol: ${protocol}`);
    }
    return adapter;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Ensures the spender contract has sufficient token allowance.
   * Uses Permit2 for Uniswap, standard ERC-20 approve for others.
   */
  private async ensureApproval(
    tokenAddress: Address,
    amount: bigint,
    quote: QuoteResult,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<void> {
    const owner = walletClient.account!.address;

    if (this.config.usePermit2 && quote.protocol === "uniswap-v4") {
      // Uniswap v4 uses Permit2 — approve token to Permit2 first,
      // then Permit2 will authorize the UniversalRouter
      await this.ensureERC20Approval(
        tokenAddress,
        PERMIT2_ADDRESS,
        amount,
        owner,
        walletClient,
        publicClient
      );
    } else {
      // Standard ERC-20 approval to the protocol's router
      const spender = this.getSpenderForProtocol(quote, walletClient.chain!.id);
      if (spender) {
        await this.ensureERC20Approval(
          tokenAddress,
          spender,
          amount,
          owner,
          walletClient,
          publicClient
        );
      }
    }
  }

  /**
   * Checks current allowance and approves if insufficient.
   */
  private async ensureERC20Approval(
    tokenAddress: Address,
    spenderAddress: Address,
    amount: bigint,
    ownerAddress: Address,
    walletClient: WalletClient,
    publicClient: PublicClient
  ): Promise<void> {
    // Check current allowance
    const currentAllowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20ABI,
      functionName: "allowance",
      args: [ownerAddress, spenderAddress],
    }) as bigint;

    if (currentAllowance >= amount) return; // Already approved

    // "exact" (default) limits exposure to this trade; "infinite" approves
    // MAX_UINT256 once to save gas on future swaps at the cost of standing risk.
    const approvalAmount = this.config.approvalStrategy === "infinite"
      ? MAX_UINT256
      : amount;

    const { request } = await publicClient.simulateContract({
      address: tokenAddress,
      abi: ERC20ABI,
      functionName: "approve",
      args: [spenderAddress, approvalAmount],
      account: ownerAddress,
    });

    await walletClient.writeContract(request);
  }

  /**
   * Returns the contract address that needs token approval for each protocol.
   */
  private getSpenderForProtocol(
    quote: QuoteResult,
    _chainId: number
  ): Address | null {
    switch (quote.protocol) {
      case "uniswap-v4":
        return PERMIT2_ADDRESS;
      case "paraswap":
        // Paraswap's TokenTransferProxy
        return "0x216B4B4Ba9F3e719726886d34a177484278Bfcae";
      case "1inch-fusion":
        return "0x111111125421cA6dc452d289314280a0f8842A65" as Address; // 1inch AggregationRouterV6
      default:
        return null;
    }
  }
}
