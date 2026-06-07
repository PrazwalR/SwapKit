/**
 * ═══════════════════════════════════════════════════════════════════════
 *   RECIPIENT SAFETY — Security Regression Test Suite
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Guards the MEDIUM-severity finding: every adapter delivers swap output to the
 * SIGNER (Uniswap v4 settles via TAKE_ALL → msgSender; 1inch/Paraswap use the
 * signer as `from`). The v4 adapter even accepted a `recipient` arg and silently
 * ignored it. A caller setting `intent.recipient` to another address would have
 * funds land in the signer's wallet with NO error.
 *
 * The fix: ExecutionEngine.execute() rejects a recipient that differs from the
 * signer, BEFORE any approval or transaction is sent.
 *
 * Run: npx tsx src/test/recipient-validation.test.ts
 *
 * Coverage:
 *   SECTION 1: Rejection — recipient != signer aborts before execution
 *   SECTION 2: Acceptance — signer / zero-address / checksum variants proceed
 *   SECTION 3: Ordering — the guard fires before approvals AND before swap submit
 */

import assert from "node:assert";
import { ExecutionEngine } from "../execution/engine.js";
import type { QuoteResult, SwapResult, SwapIntent, SwapProtocol } from "../types.js";
import type { ISwapAdapter } from "../adapters/base.js";
import type { WalletClient, PublicClient } from "viem";

// ─── Test Helpers ────────────────────────────────────────────────────────────

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

const SIGNER = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";

/** Spy adapter that records whether execute() (the swap submit) was reached. */
class SpyAdapter implements ISwapAdapter {
  readonly protocol = "paraswap" as const;
  public executeCalled = false;

  async quote(_intent: Required<SwapIntent>): Promise<QuoteResult> {
    return mockQuote();
  }

  async execute(quote: QuoteResult): Promise<SwapResult> {
    this.executeCalled = true;
    return {
      txHash: "0xabc123" as any,
      protocol: quote.protocol,
      actualAmountOut: quote.amountOut,
      gasPaidWei: quote.gasCostWei,
      mevExtractedWei: 0n,
      route: quote,
    };
  }

  supports(): boolean {
    return true;
  }
}

function mockQuote(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    protocol: "paraswap" as SwapProtocol,
    amountOut: 1_000_000_000_000_000_000n,
    gasCostWei: 50_000_000_000_000n,
    mevExposure: 0n,
    netAmountOut: 1_000_000_000_000_000_000n,
    priceImpactBps: 10,
    sandwichRisk: "low",
    routeData: { type: "paraswap", priceRoute: {}, calldata: "0x" as any },
    validUntil: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

// NOTE: default is only applied for `undefined`; pass `null` to mean "no account"
// (passing `undefined` explicitly would trigger the default and re-add the signer).
function mockWalletClient(account: string | null = SIGNER): WalletClient {
  return {
    account: account ? { address: account, type: "json-rpc" } : undefined,
    chain: {
      id: 1,
      name: "Ethereum",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://eth.llamarpc.com"] } },
    },
    transport: { type: "http", url: "https://eth.llamarpc.com" },
    writeContract: async () => "0x" as any,
  } as any;
}

/** allowance large enough that ensureApproval is skipped */
function mockPublicClient(): PublicClient {
  return {
    readContract: async () => BigInt("999999999999999999999999999999"),
    simulateContract: async () => ({ request: {} }),
  } as any;
}

/** ERC-20 intent (NOT native) so the approval path is exercised before the swap. */
function erc20Intent(recipient: string): Required<SwapIntent> {
  return {
    fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC (needs approval)
    toToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",   // USDT
    fromAmount: 1_000_000n,
    fromChainId: 1,
    toChainId: 1,
    maxSlippageBps: 50,
    deadline: Math.floor(Date.now() / 1000) + 1200,
    protocols: ["paraswap"] as SwapProtocol[],
    skipMEVCheck: false,
    recipient: recipient as any,
  };
}

/** Native-ETH intent — skips the ERC-20 approval path entirely. */
function nativeIntent(recipient: string): Required<SwapIntent> {
  return {
    ...erc20Intent(recipient),
    fromToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // native ETH
  };
}

/** Assert an async fn rejects with a recipient error. */
async function assertRejectsRecipient(fn: () => Promise<unknown>, label: string) {
  let threw = false;
  try {
    await fn();
  } catch (err: any) {
    threw = true;
    assert.match(
      err.message,
      /recipient/i,
      `${label}: rejection should mention recipient, got: ${err.message}`
    );
  }
  assert.ok(threw, `${label}: expected a rejection but none occurred`);
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║       RECIPIENT SAFETY — Security Regression Suite           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // ─── SECTION 1: Rejection ──────────────────────────────────────────────
  console.log("──── SECTION 1: recipient != signer is rejected ────");

  await test("rejects a different recipient (lowercase)", async () => {
    const engine = new ExecutionEngine([new SpyAdapter()]);
    await assertRejectsRecipient(
      () => engine.execute(erc20Intent(OTHER), mockQuote(), mockWalletClient(), mockPublicClient()),
      "different-recipient"
    );
  });

  await test("rejects a different recipient even with Flashbots disabled", async () => {
    const engine = new ExecutionEngine([new SpyAdapter()], { flashbotsEnabled: false });
    await assertRejectsRecipient(
      () => engine.execute(erc20Intent(OTHER), mockQuote(), mockWalletClient(), mockPublicClient()),
      "fb-disabled"
    );
  });

  await test("rejects a recipient that differs only by trailing bytes", async () => {
    const engine = new ExecutionEngine([new SpyAdapter()]);
    const almost = "0x1234567890abcdef1234567890abcdef12345679"; // last nibble differs
    await assertRejectsRecipient(
      () => engine.execute(erc20Intent(almost), mockQuote(), mockWalletClient(), mockPublicClient()),
      "near-miss"
    );
  });

  // ─── SECTION 2: Acceptance ─────────────────────────────────────────────
  console.log("\n──── SECTION 2: signer / zero / checksum variants proceed ────");

  await test("accepts recipient == signer (same case)", async () => {
    const spy = new SpyAdapter();
    const engine = new ExecutionEngine([spy], { flashbotsEnabled: false });
    await engine.execute(erc20Intent(SIGNER), mockQuote(), mockWalletClient(), mockPublicClient());
    assert.ok(spy.executeCalled, "swap should have executed");
  });

  await test("accepts recipient == signer (different case → checksum-insensitive)", async () => {
    const spy = new SpyAdapter();
    const engine = new ExecutionEngine([spy], { flashbotsEnabled: false });
    const upper = SIGNER.toUpperCase().replace("0X", "0x");
    await engine.execute(erc20Intent(upper), mockQuote(), mockWalletClient(), mockPublicClient());
    assert.ok(spy.executeCalled, "case-different signer address should be accepted");
  });

  await test("accepts the zero-address recipient (treated as 'use signer')", async () => {
    const spy = new SpyAdapter();
    const engine = new ExecutionEngine([spy], { flashbotsEnabled: false });
    await engine.execute(erc20Intent(ZERO), mockQuote(), mockWalletClient(), mockPublicClient());
    assert.ok(spy.executeCalled, "zero-address recipient should proceed");
  });

  await test("does NOT throw a recipient error when wallet has no account", async () => {
    // No signer to compare against → guard is skipped (adapter still runs).
    // Use a native-ETH intent so the approval path (which needs an account) is skipped.
    const spy = new SpyAdapter();
    const engine = new ExecutionEngine([spy], { flashbotsEnabled: false });
    await engine.execute(nativeIntent(OTHER), mockQuote(), mockWalletClient(null), mockPublicClient());
    assert.ok(spy.executeCalled, "guard must not block when signer is unknown");
  });

  // ─── SECTION 3: Ordering — guard fires before side effects ─────────────
  console.log("\n──── SECTION 3: guard runs before approvals & swap submit ────");

  await test("a bad recipient prevents the swap from ever executing", async () => {
    const spy = new SpyAdapter();
    const engine = new ExecutionEngine([spy], { flashbotsEnabled: false });
    try {
      await engine.execute(erc20Intent(OTHER), mockQuote(), mockWalletClient(), mockPublicClient());
    } catch {
      /* expected */
    }
    assert.strictEqual(spy.executeCalled, false, "adapter.execute must NOT be reached for a bad recipient");
  });

  await test("a bad recipient prevents token approval (no writeContract call)", async () => {
    const spy = new SpyAdapter();
    const engine = new ExecutionEngine([spy], { flashbotsEnabled: false });
    let approvalAttempted = false;
    const wallet = mockWalletClient();
    (wallet as any).writeContract = async () => {
      approvalAttempted = true;
      return "0x" as any;
    };
    // Force a low allowance so approval WOULD be attempted if the guard didn't fire first.
    const pub = {
      readContract: async () => 0n, // zero allowance → approval needed
      simulateContract: async () => ({ request: {} }),
    } as any as PublicClient;

    try {
      await engine.execute(erc20Intent(OTHER), mockQuote(), wallet, pub);
    } catch {
      /* expected */
    }
    assert.strictEqual(approvalAttempted, false, "approval must NOT be sent for a bad recipient");
  });

  // ─── RESULTS ───────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    console.error(`\n❌ ${failed} test(s) FAILED!\n`);
    process.exit(1);
  } else {
    console.log(`\n🎉 ALL ${passed} TESTS PASSED — recipient misrouting is blocked!\n`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
