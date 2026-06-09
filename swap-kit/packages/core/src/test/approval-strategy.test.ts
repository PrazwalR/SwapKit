/**
 * ═══════════════════════════════════════════════════════════════════════
 *   APPROVAL STRATEGY — Security Regression Test Suite
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Guards the MEDIUM-severity finding: ExecutionEngine always approved
 * MAX_UINT256 to third-party routers (Permit2 / Paraswap TokenTransferProxy /
 * 1inch router). A future exploit in any spender could then drain the entire
 * token balance, not just the trade amount.
 *
 * The fix: an `approvalStrategy` option, defaulting to "exact" (approve only the
 * swap amount). "infinite" remains available as an explicit opt-in for gas savings.
 *
 * Run: npx tsx src/test/approval-strategy.test.ts
 *
 * Coverage:
 *   SECTION 1: Default is "exact" — approves only the swap amount
 *   SECTION 2: "infinite" opt-in — approves MAX_UINT256
 *   SECTION 3: Skip path — sufficient allowance approves nothing
 *   SECTION 4: Permit2 (Uniswap v4) path honors the strategy
 */

import assert from "node:assert";
import { ExecutionEngine } from "../execution/engine.js";
import type { QuoteResult, SwapResult, SwapIntent, SwapProtocol } from "../types.js";
import type { ISwapAdapter } from "../adapters/base.js";
import type { WalletClient, PublicClient } from "viem";

// ─── Constants under test ──────────────────────────────────────────────────────
const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT160 = 2n ** 160n - 1n;
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
// Uniswap v4 UniversalRouter on Ethereum mainnet (chain id 1).
const UNIVERSAL_ROUTER = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
const PARASWAP_PROXY = "0x216B4B4Ba9F3e719726886d34a177484278Bfcae";
const SIGNER = "0x1234567890abcdef1234567890abcdef12345678";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SWAP_AMOUNT = 1_000_000n; // 1 USDC (6 decimals)

// ─── Test Helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS  ${name}`);
      passed++;
    })
    .catch((err: any) => {
      console.log(`❌ FAIL  ${name}`);
      console.log(`         ${err.message}`);
      failed++;
    });
}

class SpyAdapter implements ISwapAdapter {
  constructor(public readonly protocol: SwapProtocol) {}
  async quote(): Promise<QuoteResult> {
    return mockQuote(this.protocol);
  }
  async execute(quote: QuoteResult): Promise<SwapResult> {
    return {
      txHash: "0xabc" as any,
      protocol: quote.protocol,
      actualAmountOut: quote.amountOut,
      gasPaidWei: 0n,
      mevExtractedWei: 0n,
      route: quote,
    };
  }
  supports(): boolean {
    return true;
  }
}

function mockQuote(protocol: SwapProtocol): QuoteResult {
  return {
    protocol,
    amountOut: 1_000_000_000_000_000_000n,
    gasCostWei: 0n,
    mevExposure: 0n,
    netAmountOut: 1_000_000_000_000_000_000n,
    priceImpactBps: 10,
    sandwichRisk: "low",
    routeData: { type: protocol, priceRoute: {}, calldata: "0x" as any } as any,
    validUntil: Math.floor(Date.now() / 1000) + 600,
  };
}

function mockWalletClient(): WalletClient {
  return {
    account: { address: SIGNER, type: "json-rpc" },
    chain: {
      id: 1,
      name: "Ethereum",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://eth.llamarpc.com"] } },
    },
    transport: { type: "http", url: "https://eth.llamarpc.com" },
    writeContract: async () => "0xapprovetx" as any,
  } as any;
}

/**
 * Public client that reports `allowance` and records the `approve` call.
 * Returns the captured { spender, amount } via the closure.
 */
function makeCapturingPublicClient(allowance: bigint) {
  const captured: { spender: string; amount: bigint; via: "erc20" | "permit2" }[] = [];
  const client = {
    readContract: async (params: any) => {
      if (params.functionName === "allowance") {
        // Permit2.allowance(owner, token, spender) returns a (amount, expiration, nonce)
        // tuple; ERC-20 allowance(owner, spender) returns a scalar.
        if (params.args.length === 3) return [allowance, 0, 0];
        return allowance;
      }
      return 0n;
    },
    simulateContract: async (params: any) => {
      if (params.functionName === "approve") {
        if (params.args.length === 4) {
          // Permit2.approve(token, spender, amount, expiration)
          captured.push({ spender: params.args[1], amount: params.args[2], via: "permit2" });
        } else {
          // ERC-20 approve(spender, amount)
          captured.push({ spender: params.args[0], amount: params.args[1], via: "erc20" });
        }
      }
      return { request: { __captured: params.args } };
    },
  } as any as PublicClient;
  return { client, captured };
}

function erc20Intent(): Required<SwapIntent> {
  return {
    fromToken: USDC,
    toToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    fromAmount: SWAP_AMOUNT,
    fromChainId: 1,
    toChainId: 1,
    maxSlippageBps: 50,
    deadline: Math.floor(Date.now() / 1000) + 1200,
    protocols: ["paraswap"] as SwapProtocol[],
    skipMEVCheck: false,
    recipient: SIGNER, // equals signer → passes recipient guard
  };
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║       APPROVAL STRATEGY — Security Regression Suite          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // ─── SECTION 1: Default is "exact" ─────────────────────────────────────
  console.log("──── SECTION 1: default strategy approves EXACTLY the swap amount ────");

  await test("default (no config) approves exactly the swap amount, not MAX_UINT256", async () => {
    const engine = new ExecutionEngine([new SpyAdapter("paraswap")], { flashbotsEnabled: false });
    const { client, captured } = makeCapturingPublicClient(0n); // no allowance → must approve
    await engine.execute(erc20Intent(), mockQuote("paraswap"), mockWalletClient(), client);

    assert.strictEqual(captured.length, 1, "exactly one approve should be issued");
    assert.strictEqual(captured[0].amount, SWAP_AMOUNT, `should approve ${SWAP_AMOUNT}, got ${captured[0].amount}`);
    assert.notStrictEqual(captured[0].amount, MAX_UINT256, "must NOT approve MAX_UINT256 by default");
    assert.strictEqual(captured[0].spender.toLowerCase(), PARASWAP_PROXY.toLowerCase(), "spender should be Paraswap proxy");
  });

  await test("explicit approvalStrategy:'exact' approves the swap amount", async () => {
    const engine = new ExecutionEngine([new SpyAdapter("paraswap")], {
      flashbotsEnabled: false,
      approvalStrategy: "exact",
    });
    const { client, captured } = makeCapturingPublicClient(0n);
    await engine.execute(erc20Intent(), mockQuote("paraswap"), mockWalletClient(), client);
    assert.strictEqual(captured[0].amount, SWAP_AMOUNT);
  });

  // ─── SECTION 2: "infinite" opt-in ──────────────────────────────────────
  console.log("\n──── SECTION 2: 'infinite' opt-in still works ────");

  await test("approvalStrategy:'infinite' approves MAX_UINT256", async () => {
    const engine = new ExecutionEngine([new SpyAdapter("paraswap")], {
      flashbotsEnabled: false,
      approvalStrategy: "infinite",
    });
    const { client, captured } = makeCapturingPublicClient(0n);
    await engine.execute(erc20Intent(), mockQuote("paraswap"), mockWalletClient(), client);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].amount, MAX_UINT256, "infinite mode must approve MAX_UINT256");
  });

  // ─── SECTION 3: Skip path ──────────────────────────────────────────────
  console.log("\n──── SECTION 3: sufficient allowance skips approval ────");

  await test("no approval when existing allowance >= swap amount (exact)", async () => {
    const engine = new ExecutionEngine([new SpyAdapter("paraswap")], { flashbotsEnabled: false });
    const { client, captured } = makeCapturingPublicClient(SWAP_AMOUNT); // exactly enough
    await engine.execute(erc20Intent(), mockQuote("paraswap"), mockWalletClient(), client);
    assert.strictEqual(captured.length, 0, "no approve should be issued when allowance suffices");
  });

  await test("approval IS issued when allowance is just below the amount", async () => {
    const engine = new ExecutionEngine([new SpyAdapter("paraswap")], { flashbotsEnabled: false });
    const { client, captured } = makeCapturingPublicClient(SWAP_AMOUNT - 1n);
    await engine.execute(erc20Intent(), mockQuote("paraswap"), mockWalletClient(), client);
    assert.strictEqual(captured.length, 1, "shortfall of 1 wei should trigger an approval");
    assert.strictEqual(captured[0].amount, SWAP_AMOUNT);
  });

  // ─── SECTION 4: Permit2 (Uniswap v4) path ──────────────────────────────
  console.log("\n──── SECTION 4: Permit2 path honors the strategy ────");

  await test("uniswap-v4 default approves EXACT amount: ERC20→Permit2 AND Permit2→UniversalRouter", async () => {
    const engine = new ExecutionEngine([new SpyAdapter("uniswap-v4")], { flashbotsEnabled: false });
    const { client, captured } = makeCapturingPublicClient(0n);
    const intent = { ...erc20Intent(), protocols: ["uniswap-v4"] as SwapProtocol[] };
    await engine.execute(intent, mockQuote("uniswap-v4"), mockWalletClient(), client);

    assert.strictEqual(captured.length, 2, "v4 needs BOTH the ERC20→Permit2 and Permit2→UniversalRouter approvals");
    // Leg 1: ERC-20 approve(Permit2)
    assert.strictEqual(captured[0].via, "erc20");
    assert.strictEqual(captured[0].spender.toLowerCase(), PERMIT2_ADDRESS.toLowerCase(), "leg 1 spender should be Permit2");
    assert.strictEqual(captured[0].amount, SWAP_AMOUNT, "leg 1 should approve exact amount by default");
    // Leg 2: Permit2 approve(UniversalRouter)
    assert.strictEqual(captured[1].via, "permit2");
    assert.strictEqual(captured[1].spender.toLowerCase(), UNIVERSAL_ROUTER.toLowerCase(), "leg 2 spender should be the UniversalRouter");
    assert.strictEqual(captured[1].amount, SWAP_AMOUNT, "leg 2 should approve exact amount by default");
  });

  await test("uniswap-v4 infinite approves MAX_UINT256 (ERC20) and MAX_UINT160 (Permit2)", async () => {
    const engine = new ExecutionEngine([new SpyAdapter("uniswap-v4")], {
      flashbotsEnabled: false,
      approvalStrategy: "infinite",
    });
    const { client, captured } = makeCapturingPublicClient(0n);
    const intent = { ...erc20Intent(), protocols: ["uniswap-v4"] as SwapProtocol[] };
    await engine.execute(intent, mockQuote("uniswap-v4"), mockWalletClient(), client);
    assert.strictEqual(captured.length, 2);
    assert.strictEqual(captured[0].amount, MAX_UINT256, "ERC20→Permit2 infinite is uint256 max");
    assert.strictEqual(captured[0].spender.toLowerCase(), PERMIT2_ADDRESS.toLowerCase());
    assert.strictEqual(captured[1].amount, MAX_UINT160, "Permit2→router infinite is uint160 max");
    assert.strictEqual(captured[1].spender.toLowerCase(), UNIVERSAL_ROUTER.toLowerCase());
  });

  // ─── RESULTS ───────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    console.error(`\n❌ ${failed} test(s) FAILED!\n`);
    process.exit(1);
  } else {
    console.log(`\n🎉 ALL ${passed} TESTS PASSED — approvals are scoped by default!\n`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
