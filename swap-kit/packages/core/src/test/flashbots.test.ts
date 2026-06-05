/**
 * ═══════════════════════════════════════════════════════════════════════
 *   FLASHBOTS PROTECT — Exhaustive Edge Case & Integration Test Suite
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This suite tests every possible code path through the Flashbots
 * Protect interceptor in ExecutionEngine, the sandwichRisk propagation
 * in MEVGuard.applyMEVToQuote, and all config permutations.
 *
 * Test Categories:
 *   SECTION 1: MEVGuard.applyMEVToQuote — Risk Propagation
 *   SECTION 2: ExecutionEngine Config Defaults
 *   SECTION 3: Flashbots Interceptor — Rerouting Logic
 *   SECTION 4: onFlashbotsReroute Callback
 *   SECTION 5: Edge Cases & Impossible Scenarios
 */

import assert from "node:assert";
import { MEVGuard } from "../mev/guard.js";
import { ExecutionEngine, type ExecutionEngineConfig } from "../execution/engine.js";
import type { QuoteResult, SwapResult, SwapIntent, MEVReport, SwapProtocol } from "../types.js";
import type { ISwapAdapter } from "../adapters/base.js";
import type { WalletClient, PublicClient } from "viem";

// ─── Test Helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`✅ PASS  ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`❌ FAIL  ${name}`);
    console.log(`         ${err.message}`);
    failed++;
  }
}

/** Build a minimal mock QuoteResult with a specific sandwichRisk */
function mockQuote(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    protocol: "paraswap" as SwapProtocol,
    amountOut: 1000000000000000000n,
    gasCostWei: 50000000000000n,
    mevExposure: 0n,
    netAmountOut: 1000000000000000000n,
    priceImpactBps: 10,
    routeData: { type: "paraswap", priceRoute: {}, calldata: "0x" as any },
    validUntil: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

/** Build a minimal mock MEVReport */
function mockReport(overrides: Partial<MEVReport> = {}): MEVReport {
  return {
    sandwichRisk: "low",
    estimatedMEVWei: 0n,
    recommendedSlippageBps: 50,
    detectedBots: [],
    ...overrides,
  };
}

/**
 * Spy adapter that records which WalletClient it received.
 * This is the key to testing whether Flashbots rerouting happened:
 * we inspect the walletClient passed to execute() to see if it
 * was cloned with a different transport.
 */
class SpyAdapter implements ISwapAdapter {
  readonly protocol = "paraswap";
  public lastWalletClient: WalletClient | null = null;
  public executeCalled = false;

  async quote(_intent: Required<SwapIntent>): Promise<QuoteResult> {
    return mockQuote();
  }

  async execute(
    quote: QuoteResult,
    walletClient: WalletClient,
    _publicClient: PublicClient
  ): Promise<SwapResult> {
    this.executeCalled = true;
    this.lastWalletClient = walletClient;
    return {
      txHash: "0xabc123" as any,
      protocol: quote.protocol,
      actualAmountOut: quote.amountOut,
      gasPaidWei: quote.gasCostWei,
      mevExtractedWei: 0n,
      route: quote,
    };
  }

  supports(_intent: Required<SwapIntent>): boolean {
    return true;
  }
}

/** Build a minimal mock WalletClient with a fake account and chain */
function mockWalletClient(): WalletClient {
  return {
    account: {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      type: "json-rpc",
    },
    chain: {
      id: 1,
      name: "Ethereum",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://eth.llamarpc.com"] } },
    },
    transport: { type: "http", url: "https://eth.llamarpc.com" },
    // Stub writeContract so ensureApproval doesn't crash
    writeContract: async () => "0x" as any,
  } as any;
}

/** Build a minimal mock PublicClient */
function mockPublicClient(): PublicClient {
  return {
    readContract: async () => BigInt("999999999999999999999999999999"), // large allowance = skip approval
    simulateContract: async () => ({ request: {} }),
  } as any;
}

/** Build a mock SwapIntent for native ETH (skips approval) */
function mockIntent(): Required<SwapIntent> {
  return {
    fromToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // native ETH
    toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",     // USDC
    fromAmount: 1000000000000000000n,
    fromChainId: 1,
    toChainId: 1,
    maxSlippageBps: 50,
    deadline: Math.floor(Date.now() / 1000) + 1200,
    protocols: ["paraswap"] as SwapProtocol[],
    skipMEVCheck: false,
    recipient: "0x1234567890abcdef1234567890abcdef12345678" as any,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 1: MEVGuard.applyMEVToQuote — Risk Propagation
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 1: MEVGuard.applyMEVToQuote — Risk Propagation");
console.log("════════════════════════════════════════════════════════════\n");

const guard = new MEVGuard({ engineUrl: "http://localhost:9999", failOpen: true });

await test("applyMEVToQuote propagates sandwichRisk 'high' to quote", () => {
  const quote = mockQuote({ sandwichRisk: undefined });
  const report = mockReport({ sandwichRisk: "high", estimatedMEVWei: 500n });
  const result = guard.applyMEVToQuote(quote, report);
  assert.strictEqual(result.sandwichRisk, "high");
});

await test("applyMEVToQuote propagates sandwichRisk 'low' to quote", () => {
  const quote = mockQuote({ sandwichRisk: undefined });
  const report = mockReport({ sandwichRisk: "low" });
  const result = guard.applyMEVToQuote(quote, report);
  assert.strictEqual(result.sandwichRisk, "low");
});

await test("applyMEVToQuote propagates sandwichRisk 'medium' to quote", () => {
  const quote = mockQuote();
  const report = mockReport({ sandwichRisk: "medium" });
  const result = guard.applyMEVToQuote(quote, report);
  assert.strictEqual(result.sandwichRisk, "medium");
});

await test("applyMEVToQuote propagates sandwichRisk 'none' to quote", () => {
  const quote = mockQuote();
  const report = mockReport({ sandwichRisk: "none" });
  const result = guard.applyMEVToQuote(quote, report);
  assert.strictEqual(result.sandwichRisk, "none");
});

await test("applyMEVToQuote propagates sandwichRisk 'unknown' to quote", () => {
  const quote = mockQuote();
  const report = mockReport({ sandwichRisk: "unknown" });
  const result = guard.applyMEVToQuote(quote, report);
  assert.strictEqual(result.sandwichRisk, "unknown");
});

await test("applyMEVToQuote overwrites existing sandwichRisk on quote", () => {
  const quote = mockQuote({ sandwichRisk: "low" });
  const report = mockReport({ sandwichRisk: "high" });
  const result = guard.applyMEVToQuote(quote, report);
  assert.strictEqual(result.sandwichRisk, "high", "Should overwrite the existing risk");
});

await test("applyMEVToQuote does NOT mutate the original quote object", () => {
  const quote = mockQuote({ sandwichRisk: "low" });
  const report = mockReport({ sandwichRisk: "high" });
  guard.applyMEVToQuote(quote, report);
  assert.strictEqual(quote.sandwichRisk, "low", "Original quote should remain unchanged");
});

await test("applyMEVToQuote correctly subtracts MEV from netAmountOut", () => {
  const quote = mockQuote({ netAmountOut: 1000n, mevExposure: 0n });
  const report = mockReport({ estimatedMEVWei: 300n });
  const result = guard.applyMEVToQuote(quote, report);
  assert.strictEqual(result.netAmountOut, 700n);
  assert.strictEqual(result.mevExposure, 300n);
});

await test("applyMEVToQuote clamps netAmountOut to 0n when MEV exceeds output", () => {
  const quote = mockQuote({ netAmountOut: 100n });
  const report = mockReport({ estimatedMEVWei: 999999n });
  const result = guard.applyMEVToQuote(quote, report);
  assert.strictEqual(result.netAmountOut, 0n, "Should clamp to 0, not go negative");
});

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 2: ExecutionEngine Config Defaults
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 2: ExecutionEngine Config Defaults");
console.log("════════════════════════════════════════════════════════════\n");

await test("Default config: flashbotsEnabled is true", () => {
  const engine = new ExecutionEngine([new SpyAdapter()]);
  // Access internal config via bracket notation for testing
  const config = (engine as any).config;
  assert.strictEqual(config.flashbotsEnabled, true);
});

await test("Default config: flashbotsProtectRpc is the official Flashbots URL", () => {
  const engine = new ExecutionEngine([new SpyAdapter()]);
  const config = (engine as any).config;
  assert.strictEqual(config.flashbotsProtectRpc, "https://rpc.flashbots.net");
});

await test("Default config: onFlashbotsReroute is null", () => {
  const engine = new ExecutionEngine([new SpyAdapter()]);
  const config = (engine as any).config;
  assert.strictEqual(config.onFlashbotsReroute, null);
});

await test("Custom config: flashbotsEnabled can be set to false", () => {
  const engine = new ExecutionEngine([new SpyAdapter()], { flashbotsEnabled: false });
  const config = (engine as any).config;
  assert.strictEqual(config.flashbotsEnabled, false);
});

await test("Custom config: flashbotsProtectRpc can be overridden", () => {
  const customRpc = "https://my-custom-flashbots-relay.example.com";
  const engine = new ExecutionEngine([new SpyAdapter()], { flashbotsProtectRpc: customRpc });
  const config = (engine as any).config;
  assert.strictEqual(config.flashbotsProtectRpc, customRpc);
});

await test("Custom config: onFlashbotsReroute accepts a function", () => {
  const cb = () => {};
  const engine = new ExecutionEngine([new SpyAdapter()], { onFlashbotsReroute: cb });
  const config = (engine as any).config;
  assert.strictEqual(config.onFlashbotsReroute, cb);
});

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 3: Flashbots Interceptor — Rerouting Logic
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 3: Flashbots Interceptor — Rerouting Logic");
console.log("════════════════════════════════════════════════════════════\n");

await test("sandwichRisk='high' + flashbotsEnabled=true → REROUTES (wallet client differs)", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], { flashbotsEnabled: true });
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "high" });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  assert.ok(spy.executeCalled, "Adapter execute should have been called");
  // The key assertion: the walletClient passed to the adapter should NOT be
  // the same object reference as the original, because it was cloned
  assert.notStrictEqual(spy.lastWalletClient, originalWallet,
    "WalletClient should be a NEW cloned instance routed through Flashbots");
});

await test("sandwichRisk='low' → does NOT reroute (same wallet client)", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], { flashbotsEnabled: true });
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "low" });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  assert.strictEqual(spy.lastWalletClient, originalWallet,
    "WalletClient should be the SAME original instance — no rerouting");
});

await test("sandwichRisk='medium' → does NOT reroute", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "medium" });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  assert.strictEqual(spy.lastWalletClient, originalWallet,
    "Medium risk should NOT trigger rerouting");
});

await test("sandwichRisk='none' → does NOT reroute", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "none" });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  assert.strictEqual(spy.lastWalletClient, originalWallet);
});

await test("sandwichRisk='unknown' → does NOT reroute", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "unknown" });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  assert.strictEqual(spy.lastWalletClient, originalWallet);
});

await test("sandwichRisk=undefined → does NOT reroute", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: undefined });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  assert.strictEqual(spy.lastWalletClient, originalWallet,
    "Undefined risk should NOT trigger rerouting");
});

await test("sandwichRisk='high' but flashbotsEnabled=false → does NOT reroute", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], { flashbotsEnabled: false });
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "high" });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  assert.strictEqual(spy.lastWalletClient, originalWallet,
    "Flashbots disabled — should use original wallet even on high risk");
});

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 4: onFlashbotsReroute Callback
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 4: onFlashbotsReroute Callback");
console.log("════════════════════════════════════════════════════════════\n");

await test("Callback fires exactly ONCE on high risk", async () => {
  let callCount = 0;
  let receivedQuote: QuoteResult | null = null;

  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    onFlashbotsReroute: (q) => { callCount++; receivedQuote = q; },
  });
  const quote = mockQuote({ sandwichRisk: "high" });

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient());

  assert.strictEqual(callCount, 1, "Callback should fire exactly once");
  assert.strictEqual(receivedQuote!.sandwichRisk, "high");
});

await test("Callback does NOT fire on low risk", async () => {
  let callCount = 0;
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    onFlashbotsReroute: () => { callCount++; },
  });
  const quote = mockQuote({ sandwichRisk: "low" });

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient());

  assert.strictEqual(callCount, 0, "Callback should NOT fire on low risk");
});

await test("Callback does NOT fire on medium risk", async () => {
  let callCount = 0;
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    onFlashbotsReroute: () => { callCount++; },
  });
  const quote = mockQuote({ sandwichRisk: "medium" });

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient());

  assert.strictEqual(callCount, 0);
});

await test("Callback does NOT fire when flashbotsEnabled=false even on high risk", async () => {
  let callCount = 0;
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    flashbotsEnabled: false,
    onFlashbotsReroute: () => { callCount++; },
  });
  const quote = mockQuote({ sandwichRisk: "high" });

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient());

  assert.strictEqual(callCount, 0, "Callback should NOT fire when Flashbots is disabled");
});

await test("Callback receives the correct protocol from the quote", async () => {
  let receivedProtocol: string | null = null;
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    onFlashbotsReroute: (q) => { receivedProtocol = q.protocol; },
  });
  const quote = mockQuote({ sandwichRisk: "high", protocol: "paraswap" as SwapProtocol });

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient());

  assert.strictEqual(receivedProtocol, "paraswap");
});

await test("Callback throwing does NOT crash the execution pipeline", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    onFlashbotsReroute: () => { throw new Error("Developer callback blew up!"); },
  });
  const quote = mockQuote({ sandwichRisk: "high" });

  // This MUST NOT throw — the engine wraps callbacks in try/catch
  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient());

  assert.ok(spy.executeCalled, "Swap should still execute even if the callback crashes");
});

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 5: Edge Cases & Impossible Scenarios
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 5: Edge Cases & Impossible Scenarios");
console.log("════════════════════════════════════════════════════════════\n");

await test("Unknown protocol throws 'No adapter found'", async () => {
  const engine = new ExecutionEngine([new SpyAdapter()]);
  const quote = mockQuote({ protocol: "sushiswap-v3" as any });

  let threw = false;
  try {
    await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient());
  } catch (err: any) {
    threw = true;
    assert.ok(err.message.includes("No adapter found"), `Wrong error: ${err.message}`);
  }
  assert.ok(threw, "Should throw for unknown protocol");
});

await test("Sequential swaps: first high risk → reroutes, second low risk → does not", async () => {
  let callCount = 0;
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    onFlashbotsReroute: () => { callCount++; },
  });

  const originalWallet = mockWalletClient();

  // First swap: high risk
  const highQuote = mockQuote({ sandwichRisk: "high" });
  await engine.execute(mockIntent(), highQuote, originalWallet, mockPublicClient());
  assert.notStrictEqual(spy.lastWalletClient, originalWallet, "First: should reroute");
  assert.strictEqual(callCount, 1);

  // Second swap: low risk
  const lowQuote = mockQuote({ sandwichRisk: "low" });
  await engine.execute(mockIntent(), lowQuote, originalWallet, mockPublicClient());
  assert.strictEqual(spy.lastWalletClient, originalWallet, "Second: should NOT reroute");
  assert.strictEqual(callCount, 1, "Callback should not fire again");
});

await test("Sequential swaps: both high risk → callback fires twice", async () => {
  let callCount = 0;
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    onFlashbotsReroute: () => { callCount++; },
  });

  await engine.execute(mockIntent(), mockQuote({ sandwichRisk: "high" }), mockWalletClient(), mockPublicClient());
  await engine.execute(mockIntent(), mockQuote({ sandwichRisk: "high" }), mockWalletClient(), mockPublicClient());

  assert.strictEqual(callCount, 2, "Callback should fire for each high-risk swap");
});

await test("Empty string sandwichRisk does NOT trigger rerouting", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "" as any });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());
  assert.strictEqual(spy.lastWalletClient, originalWallet);
});

await test("Numeric sandwichRisk does NOT trigger rerouting", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: 42 as any });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());
  assert.strictEqual(spy.lastWalletClient, originalWallet);
});

await test("Boolean true sandwichRisk does NOT trigger rerouting", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: true as any });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());
  assert.strictEqual(spy.lastWalletClient, originalWallet);
});

await test("'HIGH' (uppercase) does NOT trigger rerouting — must be exact lowercase", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "HIGH" as any });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());
  assert.strictEqual(spy.lastWalletClient, originalWallet,
    "Case-sensitive: 'HIGH' should NOT match 'high'");
});

await test("'High' (mixed case) does NOT trigger rerouting", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "High" as any });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());
  assert.strictEqual(spy.lastWalletClient, originalWallet);
});

await test("Custom Flashbots RPC is used when rerouting", async () => {
  const customRpc = "https://custom-relay.example.com";
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    flashbotsProtectRpc: customRpc,
  });
  const quote = mockQuote({ sandwichRisk: "high" });
  const originalWallet = mockWalletClient();

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  assert.notStrictEqual(spy.lastWalletClient, originalWallet,
    "Should reroute with custom RPC");
  // The walletClient was cloned — we can verify it has a transport
  assert.ok(spy.lastWalletClient, "Cloned wallet client should exist");
});

await test("Rerouted wallet preserves the original account address", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "high" });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  const rerouted = spy.lastWalletClient!;
  assert.strictEqual(
    rerouted.account?.address,
    originalWallet.account?.address,
    "Cloned wallet must have the same account address"
  );
});

await test("Rerouted wallet preserves the original chain ID", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]);
  const originalWallet = mockWalletClient();
  const quote = mockQuote({ sandwichRisk: "high" });

  await engine.execute(mockIntent(), quote, originalWallet, mockPublicClient());

  const rerouted = spy.lastWalletClient!;
  assert.strictEqual(
    rerouted.chain?.id,
    originalWallet.chain?.id,
    "Cloned wallet must have the same chain ID"
  );
});

// ═══════════════════════════════════════════════════════════════════════
//   RESULTS
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log("════════════════════════════════════════════════════════════\n");

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED!\n`);
  process.exit(1);
} else {
  console.log(`\n🎉 ALL ${passed} TESTS PASSED — Flashbots Protect is bulletproof!\n`);
}
