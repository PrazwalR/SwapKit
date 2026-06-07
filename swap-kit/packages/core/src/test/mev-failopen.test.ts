/**
 * ═══════════════════════════════════════════════════════════════════════
 *   MEV FAIL-SAFE — Security Regression Test Suite
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Guards the MEDIUM-severity finding: the Flashbots interceptor only rerouted
 * on sandwichRisk === "high". A down / slow / compromised MEV engine returns
 * "unknown" (MEVGuard fail-open), which silently left swaps UNPROTECTED.
 *
 * The fix: an opt-in `flashbotsRerouteOnUnknownRisk` toggle. When enabled, the
 * interceptor also reroutes on "unknown" risk (fail-SAFE). Default is false so
 * we don't reroute every swap to a mainnet RPC when no engine is configured
 * (and to avoid breaking L2 swaps).
 *
 * Run: npx tsx src/test/mev-failopen.test.ts
 *
 * Reroute detection: ExecutionEngine clones the WalletClient (new transport)
 * only when rerouting, so `spy.lastWalletClient !== originalWallet` ⇒ rerouted.
 *
 * Coverage:
 *   SECTION 1: Default (fail-open preserved) — unknown does NOT reroute
 *   SECTION 2: Fail-safe ON — unknown DOES reroute; high still reroutes
 *   SECTION 3: Fail-safe ON — low/medium/none never reroute
 *   SECTION 4: Master switch & callback interaction
 */

import assert from "node:assert";
import { ExecutionEngine } from "../execution/engine.js";
import type { QuoteResult, SwapResult, SwapIntent, SwapProtocol } from "../types.js";
import type { ISwapAdapter } from "../adapters/base.js";
import type { WalletClient, PublicClient } from "viem";

const SIGNER = "0x1234567890abcdef1234567890abcdef12345678";

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
  readonly protocol = "paraswap" as const;
  public lastWalletClient: WalletClient | null = null;

  async quote(): Promise<QuoteResult> {
    return mockQuote("unknown");
  }
  async execute(quote: QuoteResult, walletClient: WalletClient): Promise<SwapResult> {
    this.lastWalletClient = walletClient;
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

function mockQuote(sandwichRisk: QuoteResult["sandwichRisk"]): QuoteResult {
  return {
    protocol: "paraswap" as SwapProtocol,
    amountOut: 1_000_000_000_000_000_000n,
    gasCostWei: 0n,
    mevExposure: 0n,
    netAmountOut: 1_000_000_000_000_000_000n,
    priceImpactBps: 10,
    sandwichRisk,
    routeData: { type: "paraswap", priceRoute: {}, calldata: "0x" as any },
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
    writeContract: async () => "0x" as any,
  } as any;
}

function mockPublicClient(): PublicClient {
  return {
    readContract: async () => BigInt("999999999999999999999999999999"),
    simulateContract: async () => ({ request: {} }),
  } as any;
}

/** Native-ETH intent (skips approval); recipient == signer (passes recipient guard). */
function mockIntent(): Required<SwapIntent> {
  return {
    fromToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    fromAmount: 1_000_000_000_000_000_000n,
    fromChainId: 1,
    toChainId: 1,
    maxSlippageBps: 50,
    deadline: Math.floor(Date.now() / 1000) + 1200,
    protocols: ["paraswap"] as SwapProtocol[],
    skipMEVCheck: false,
    recipient: SIGNER as any,
  };
}

/** Run an execute() and report whether a reroute (wallet clone) happened. */
async function didReroute(
  config: ConstructorParameters<typeof ExecutionEngine>[1],
  risk: QuoteResult["sandwichRisk"]
): Promise<boolean> {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], config);
  const originalWallet = mockWalletClient();
  await engine.execute(mockIntent(), mockQuote(risk), originalWallet, mockPublicClient());
  return spy.lastWalletClient !== originalWallet;
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║       MEV FAIL-SAFE — Security Regression Suite              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // ─── SECTION 1: Default behavior preserved ─────────────────────────────
  console.log("──── SECTION 1: default (toggle off) — unknown does NOT reroute ────");

  await test("default config: unknown risk → NO reroute (backwards compatible)", async () => {
    assert.strictEqual(await didReroute({ flashbotsEnabled: true }, "unknown"), false);
  });
  await test("default config: high risk → still reroutes", async () => {
    assert.strictEqual(await didReroute({ flashbotsEnabled: true }, "high"), true);
  });

  // ─── SECTION 2: Fail-safe enabled ──────────────────────────────────────
  console.log("\n──── SECTION 2: flashbotsRerouteOnUnknownRisk:true ────");

  await test("unknown risk → REROUTES when fail-safe is enabled (the fix)", async () => {
    assert.strictEqual(
      await didReroute({ flashbotsEnabled: true, flashbotsRerouteOnUnknownRisk: true }, "unknown"),
      true
    );
  });
  await test("high risk → still reroutes with fail-safe enabled", async () => {
    assert.strictEqual(
      await didReroute({ flashbotsEnabled: true, flashbotsRerouteOnUnknownRisk: true }, "high"),
      true
    );
  });

  // ─── SECTION 3: Fail-safe does not over-reroute ────────────────────────
  console.log("\n──── SECTION 3: fail-safe ON must NOT reroute low/medium/none ────");

  for (const risk of ["low", "medium", "none"] as const) {
    await test(`'${risk}' risk → NO reroute even with fail-safe enabled`, async () => {
      assert.strictEqual(
        await didReroute({ flashbotsEnabled: true, flashbotsRerouteOnUnknownRisk: true }, risk),
        false
      );
    });
  }

  // ─── SECTION 4: Master switch & callback ───────────────────────────────
  console.log("\n──── SECTION 4: master switch & callback interaction ────");

  await test("flashbotsEnabled:false overrides fail-safe (no reroute on unknown)", async () => {
    assert.strictEqual(
      await didReroute({ flashbotsEnabled: false, flashbotsRerouteOnUnknownRisk: true }, "unknown"),
      false
    );
  });

  await test("onFlashbotsReroute callback fires when rerouting on unknown risk", async () => {
    let fired = false;
    let receivedRisk: string | undefined;
    const spy = new SpyAdapter();
    const engine = new ExecutionEngine([spy], {
      flashbotsEnabled: true,
      flashbotsRerouteOnUnknownRisk: true,
      onFlashbotsReroute: (q) => {
        fired = true;
        receivedRisk = q.sandwichRisk;
      },
    });
    await engine.execute(mockIntent(), mockQuote("unknown"), mockWalletClient(), mockPublicClient());
    assert.ok(fired, "callback should fire on fail-safe reroute");
    assert.strictEqual(receivedRisk, "unknown", "callback should receive the unknown-risk quote");
  });

  await test("rerouted-on-unknown wallet preserves account + chain id", async () => {
    const spy = new SpyAdapter();
    const engine = new ExecutionEngine([spy], {
      flashbotsEnabled: true,
      flashbotsRerouteOnUnknownRisk: true,
    });
    const original = mockWalletClient();
    await engine.execute(mockIntent(), mockQuote("unknown"), original, mockPublicClient());
    const rerouted = spy.lastWalletClient!;
    assert.notStrictEqual(rerouted, original, "should be a cloned client");
    assert.strictEqual(rerouted.account?.address, original.account?.address, "account preserved");
    assert.strictEqual(rerouted.chain?.id, original.chain?.id, "chain id preserved");
  });

  // ─── RESULTS ───────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    console.error(`\n❌ ${failed} test(s) FAILED!\n`);
    process.exit(1);
  } else {
    console.log(`\n🎉 ALL ${passed} TESTS PASSED — MEV fail-safe works as designed!\n`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
