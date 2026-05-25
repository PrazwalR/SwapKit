import type { WalletClient, PublicClient, Address, Hex } from "viem";
import type { SwapIntent, QuoteResult, SwapResult, SwapProtocol } from "../types.js";
import type { ISwapAdapter } from "../adapters/base.js";
import { ERC20ABI, Permit2ABI } from "../abis/index.js";
import { isNativeToken } from "../utils/token.js";

// Permit2 is deployed at the same address on all chains
const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Max uint256 for unlimited approval
const MAX_UINT256 = 2n ** 256n - 1n;

export interface ExecutionEngineConfig {
  /** Auto-approve tokens before swapping. Default: true */
  autoApprove?: boolean;
  /** Use Permit2 for approvals (Uniswap). Default: true */
  usePermit2?: boolean;
}

/**
 * ExecutionEngine handles the full lifecycle of a swap:
 * 1. Check & set token approvals (ERC-20 approve or Permit2)
 * 2. Submit the transaction via the appropriate adapter
 * 3. Wait for confirmation and parse the receipt
 */
export class ExecutionEngine {
  private adapters: Map<SwapProtocol, ISwapAdapter>;
  private config: Required<ExecutionEngineConfig>;

  constructor(
    adapters: ISwapAdapter[],
    config: ExecutionEngineConfig = {}
  ) {
    this.adapters = new Map(
      adapters.map(a => [a.protocol as SwapProtocol, a])
    );
    this.config = {
      autoApprove: config.autoApprove ?? true,
      usePermit2:  config.usePermit2 ?? true,
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

    // Step 1: Handle token approvals (skip for native ETH and gasless protocols)
    if (
      this.config.autoApprove &&
      !isNativeToken(intent.fromToken as string) &&
      quote.protocol !== "1inch-fusion" // Fusion+ handles approvals differently
    ) {
      await this.ensureApproval(
        intent.fromToken as Address,
        intent.fromAmount,
        quote,
        walletClient,
        publicClient
      );
    }

    // Step 2: Execute the swap via adapter
    return adapter.execute(quote, walletClient, publicClient);
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

    // Approve max amount (one-time, saves gas on future swaps)
    const { request } = await publicClient.simulateContract({
      address: tokenAddress,
      abi: ERC20ABI,
      functionName: "approve",
      args: [spenderAddress, MAX_UINT256],
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
        return null; // Gasless, no approval needed from user
      default:
        return null;
    }
  }
}
