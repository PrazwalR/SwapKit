/**
 * ═══════════════════════════════════════════════════════════════════════
 *   GASLESS SWAPS — Exhaustive Edge Case & Integration Test Suite
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Test Categories:
 *   SECTION 1: checkGasAffordability — Gas Detection Logic
 *   SECTION 2: ExecutionEngine Gasless Config Defaults
 *   SECTION 3: Gasless Interceptor — Detection & Error Behavior
 *   SECTION 4: onGaslessSwap Callback
 *   SECTION 5: Edge Cases & Combined Interceptors
 */

import assert from "node:assert";
import { checkGasAffordability, type GasCheck } from "../gasless/detector.js";
import { ExecutionEngine } from "../execution/engine.js";
import type { QuoteResult, SwapResult, SwapIntent, SwapProtocol } from "../types.js";
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

function mockQuote(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    protocol: "paraswap" as SwapProtocol,
    amountOut: 1000000000000000000n,
    gasCostWei: 50000000000000n, // 0.00005 ETH
    mevExposure: 0n,
    netAmountOut: 1000000000000000000n,
    priceImpactBps: 10,
    routeData: { type: "paraswap", priceRoute: {}, calldata: "0x" as any },
    validUntil: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

class SpyAdapter implements ISwapAdapter {
  readonly protocol = "paraswap";
  public executeCalled = false;

  async quote(_intent: Required<SwapIntent>): Promise<QuoteResult> {
    return mockQuote();
  }

  async execute(
    quote: QuoteResult,
    _walletClient: WalletClient,
    _publicClient: PublicClient
  ): Promise<SwapResult> {
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

  supports(_intent: Required<SwapIntent>): boolean {
    return true;
  }
}

/** Mock wallet with configurable account */
function mockWalletClient(hasAccount = true): WalletClient {
  return {
    account: hasAccount
      ? { address: "0x1234567890abcdef1234567890abcdef12345678", type: "json-rpc" }
      : undefined,
    chain: {
      id: 1, name: "Ethereum",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://eth.llamarpc.com"] } },
    },
    transport: { type: "http", url: "https://eth.llamarpc.com" },
    writeContract: async () => "0x" as any,
  } as any;
}

/** Mock public client with configurable ETH balance */
function mockPublicClient(balanceWei: bigint = 1000000000000000000n): PublicClient {
  return {
    getBalance: async () => balanceWei,
    readContract: async () => BigInt("999999999999999999999999999999"),
    simulateContract: async () => ({ request: {} }),
  } as any;
}

function mockIntent(): Required<SwapIntent> {
  return {
    fromToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
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
//   SECTION 1: checkGasAffordability — Gas Detection Logic
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 1: checkGasAffordability — Gas Detection Logic");
console.log("════════════════════════════════════════════════════════════\n");

await test("Rich wallet (1 ETH) can afford gas (0.00005 ETH)", async () => {
  const quote = mockQuote({ gasCostWei: 50000000000000n });
  const result = await checkGasAffordability(
    mockWalletClient(),
    mockPublicClient(1000000000000000000n), // 1 ETH
    quote,
  );
  assert.strictEqual(result.canAffordGas, true);
  assert.strictEqual(result.shortfallWei, 0n);
  assert.strictEqual(result.userBalanceWei, 1000000000000000000n);
});

await test("Empty wallet (0 ETH) cannot afford gas", async () => {
  const quote = mockQuote({ gasCostWei: 50000000000000n });
  const result = await checkGasAffordability(
    mockWalletClient(),
    mockPublicClient(0n), // 0 ETH
    quote,
  );
  assert.strictEqual(result.canAffordGas, false);
  assert.ok(result.shortfallWei > 0n, "Shortfall should be positive");
  assert.strictEqual(result.userBalanceWei, 0n);
});

await test("Wallet with exactly the gas cost (no safety margin) is marked insufficient", async () => {
  // Gas cost = 100, with 20% margin = 120. User has exactly 100 → short.
  const quote = mockQuote({ gasCostWei: 100n });
  const result = await checkGasAffordability(
    mockWalletClient(),
    mockPublicClient(100n),
    quote,
  );
  assert.strictEqual(result.canAffordGas, false,
    "Should fail because the 20% safety margin makes 100 insufficient for 120");
  assert.strictEqual(result.shortfallWei, 20n, "Short by 20 wei (120 needed - 100 available)");
});

await test("Wallet with exactly the margined cost passes", async () => {
  // Gas cost = 100, with 20% margin = 120. User has 120 → passes.
  const quote = mockQuote({ gasCostWei: 100n });
  const result = await checkGasAffordability(
    mockWalletClient(),
    mockPublicClient(120n),
    quote,
  );
  assert.strictEqual(result.canAffordGas, true);
  assert.strictEqual(result.shortfallWei, 0n);
});

await test("Wallet with 1 wei over the margin passes", async () => {
  const quote = mockQuote({ gasCostWei: 100n });
  const result = await checkGasAffordability(
    mockWalletClient(),
    mockPublicClient(121n),
    quote,
  );
  assert.strictEqual(result.canAffordGas, true);
  assert.strictEqual(result.shortfallWei, 0n);
});

await test("Wallet with 1 wei under the margin fails", async () => {
  const quote = mockQuote({ gasCostWei: 100n });
  const result = await checkGasAffordability(
    mockWalletClient(),
    mockPublicClient(119n),
    quote,
  );
  assert.strictEqual(result.canAffordGas, false);
  assert.strictEqual(result.shortfallWei, 1n, "Short by exactly 1 wei");
});

await test("Zero gas cost quote: user can always afford it", async () => {
  const quote = mockQuote({ gasCostWei: 0n });
  const result = await checkGasAffordability(
    mockWalletClient(),
    mockPublicClient(0n), // Even with 0 balance
    quote,
  );
  assert.strictEqual(result.canAffordGas, true);
  assert.strictEqual(result.shortfallWei, 0n);
});

await test("Massive gas cost (100 ETH) correctly detected as unaffordable", async () => {
  const quote = mockQuote({ gasCostWei: 100000000000000000000n }); // 100 ETH
  const result = await checkGasAffordability(
    mockWalletClient(),
    mockPublicClient(1000000000000000000n), // 1 ETH
    quote,
  );
  assert.strictEqual(result.canAffordGas, false);
  assert.ok(result.shortfallWei > 0n);
});

await test("No account on wallet: defaults to cannot afford gas", async () => {
  const quote = mockQuote({ gasCostWei: 100n });
  const result = await checkGasAffordability(
    mockWalletClient(false), // No account
    mockPublicClient(999999999n),
    quote,
  );
  assert.strictEqual(result.canAffordGas, false);
  assert.strictEqual(result.userBalanceWei, 0n);
});

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 2: ExecutionEngine Gasless Config Defaults
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 2: ExecutionEngine Gasless Config Defaults");
console.log("════════════════════════════════════════════════════════════\n");

await test("Default: gasless.enabled is false", () => {
  const engine = new ExecutionEngine([new SpyAdapter()]);
  const config = (engine as any).config;
  assert.strictEqual(config.gasless.enabled, false);
});

await test("Default: gasless.paymasterUrl is null", () => {
  const engine = new ExecutionEngine([new SpyAdapter()]);
  const config = (engine as any).config;
  assert.strictEqual(config.gasless.paymasterUrl, null);
});

await test("Default: gasless.onGaslessSwap is null", () => {
  const engine = new ExecutionEngine([new SpyAdapter()]);
  const config = (engine as any).config;
  assert.strictEqual(config.gasless.onGaslessSwap, null);
});

await test("Custom: gasless.enabled can be set to true", () => {
  const engine = new ExecutionEngine([new SpyAdapter()], {
    gasless: { enabled: true },
  });
  const config = (engine as any).config;
  assert.strictEqual(config.gasless.enabled, true);
});

await test("Custom: paymasterUrl can be configured", () => {
  const url = "https://paymaster.example.com";
  const engine = new ExecutionEngine([new SpyAdapter()], {
    gasless: { enabled: true, paymasterUrl: url },
  });
  const config = (engine as any).config;
  assert.strictEqual(config.gasless.paymasterUrl, url);
});

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 3: Gasless Interceptor — Detection & Error Behavior
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 3: Gasless Interceptor — Detection & Error");
console.log("════════════════════════════════════════════════════════════\n");

await test("Gasless disabled (default): swap proceeds normally even with 0 balance", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy]); // gasless disabled by default
  const quote = mockQuote();

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(0n));

  assert.ok(spy.executeCalled, "Swap should proceed normally when gasless is disabled");
});

await test("Gasless enabled + rich wallet: swap proceeds normally", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    gasless: { enabled: true },
  });
  const quote = mockQuote({ gasCostWei: 100n });

  // User has 10000 wei — more than enough
  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(10000n));

  assert.ok(spy.executeCalled, "Swap should proceed when user can afford gas");
});

await test("Gasless enabled + empty wallet: throws descriptive error", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    gasless: { enabled: true },
  });
  const quote = mockQuote({ gasCostWei: 50000000000000n });

  let threw = false;
  let errorMsg = "";
  try {
    await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(0n));
  } catch (err: any) {
    threw = true;
    errorMsg = err.message;
  }

  assert.ok(threw, "Should throw when user cannot afford gas");
  assert.ok(errorMsg.includes("Insufficient gas"), `Error should mention gas: "${errorMsg}"`);
  assert.ok(errorMsg.includes("Paymaster"), `Error should mention Paymaster: "${errorMsg}"`);
  assert.ok(!spy.executeCalled, "Swap should NOT execute when user is broke");
});

await test("Gasless enabled + marginal balance: throws when 1 wei under margin", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    gasless: { enabled: true },
  });
  const quote = mockQuote({ gasCostWei: 100n });
  // Needs 120 (100 + 20% margin), user has 119

  let threw = false;
  try {
    await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(119n));
  } catch {
    threw = true;
  }

  assert.ok(threw, "Should throw when 1 wei under safety margin");
  assert.ok(!spy.executeCalled);
});

await test("Gasless enabled + exactly at margin: swap proceeds", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    gasless: { enabled: true },
  });
  const quote = mockQuote({ gasCostWei: 100n });
  // Needs 120, user has 120

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(120n));

  assert.ok(spy.executeCalled, "Should proceed when user has exactly enough with margin");
});

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 4: onGaslessSwap Callback
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 4: onGaslessSwap Callback");
console.log("════════════════════════════════════════════════════════════\n");

await test("Callback fires when user cannot afford gas", async () => {
  let callCount = 0;
  // Holder object: a `let` assigned only inside a closure gets narrowed by CFA to
  // its `null` initializer, which `assert.ok` then collapses to `never`. A property
  // on an object is not narrowed that way, so this keeps its declared type.
  const received: { check: GasCheck | null } = { check: null };

  const engine = new ExecutionEngine([new SpyAdapter()], {
    gasless: {
      enabled: true,
      onGaslessSwap: (check) => { callCount++; received.check = check; },
    },
  });
  const quote = mockQuote({ gasCostWei: 50000000000000n });

  try {
    await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(0n));
  } catch { /* Expected */ }

  assert.strictEqual(callCount, 1, "Callback should fire exactly once");
  assert.ok(received.check, "Callback should receive a GasCheck object");
  assert.strictEqual(received.check.canAffordGas, false);
  assert.strictEqual(received.check.userBalanceWei, 0n);
  assert.ok(received.check.shortfallWei > 0n);
});

await test("Callback does NOT fire when user can afford gas", async () => {
  let callCount = 0;

  const engine = new ExecutionEngine([new SpyAdapter()], {
    gasless: {
      enabled: true,
      onGaslessSwap: () => { callCount++; },
    },
  });
  const quote = mockQuote({ gasCostWei: 100n });

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(10000n));

  assert.strictEqual(callCount, 0, "Callback should NOT fire when gas is affordable");
});

await test("Callback does NOT fire when gasless is disabled", async () => {
  let callCount = 0;

  const engine = new ExecutionEngine([new SpyAdapter()], {
    gasless: {
      enabled: false,
      onGaslessSwap: () => { callCount++; },
    },
  });
  const quote = mockQuote({ gasCostWei: 50000000000000n });

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(0n));

  assert.strictEqual(callCount, 0, "Callback should NOT fire when gasless is disabled");
});

await test("Crashing callback does NOT prevent the error from being thrown", async () => {
  const engine = new ExecutionEngine([new SpyAdapter()], {
    gasless: {
      enabled: true,
      onGaslessSwap: () => { throw new Error("Callback exploded!"); },
    },
  });
  const quote = mockQuote({ gasCostWei: 50000000000000n });

  let threw = false;
  let errorMsg = "";
  try {
    await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(0n));
  } catch (err: any) {
    threw = true;
    errorMsg = err.message;
  }

  assert.ok(threw, "Should still throw the Insufficient gas error");
  assert.ok(errorMsg.includes("Insufficient gas"), "Should be the gas error, not the callback error");
});

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 5: Edge Cases & Combined Interceptors
// ═══════════════════════════════════════════════════════════════════════

console.log("\n════════════════════════════════════════════════════════════");
console.log("  SECTION 5: Edge Cases & Combined Interceptors");
console.log("════════════════════════════════════════════════════════════\n");

await test("Flashbots + Gasless both active: Flashbots reroutes first, then gas check passes", async () => {
  let flashbotsCallCount = 0;
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    flashbotsEnabled: true,
    onFlashbotsReroute: () => { flashbotsCallCount++; },
    gasless: { enabled: true },
  });
  const quote = mockQuote({ sandwichRisk: "high", gasCostWei: 100n });

  // User has 10000 — enough gas
  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(10000n));

  assert.strictEqual(flashbotsCallCount, 1, "Flashbots should fire");
  assert.ok(spy.executeCalled, "Swap should complete");
});

await test("Flashbots + Gasless both active: reroutes then gas check fails", async () => {
  let flashbotsCallCount = 0;
  let gaslessCallCount = 0;
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    flashbotsEnabled: true,
    onFlashbotsReroute: () => { flashbotsCallCount++; },
    gasless: {
      enabled: true,
      onGaslessSwap: () => { gaslessCallCount++; },
    },
  });
  const quote = mockQuote({ sandwichRisk: "high", gasCostWei: 50000000000000n });

  let threw = false;
  try {
    await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(0n));
  } catch {
    threw = true;
  }

  assert.strictEqual(flashbotsCallCount, 1, "Flashbots should fire first");
  assert.strictEqual(gaslessCallCount, 1, "Gasless callback should fire second");
  assert.ok(threw, "Should throw the gas error");
  assert.ok(!spy.executeCalled, "Swap should NOT complete");
});

await test("Gasless check with zero gas cost: always passes (free transaction)", async () => {
  const spy = new SpyAdapter();
  const engine = new ExecutionEngine([spy], {
    gasless: { enabled: true },
  });
  const quote = mockQuote({ gasCostWei: 0n });

  await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(0n));

  assert.ok(spy.executeCalled, "Zero-gas transactions should always pass");
});

await test("GasCheck shortfallWei is mathematically correct", async () => {
  const received: { check: GasCheck | null } = { check: null };

  const engine = new ExecutionEngine([new SpyAdapter()], {
    gasless: {
      enabled: true,
      onGaslessSwap: (check) => { received.check = check; },
    },
  });
  // Gas cost 1000, margin = 1200, user has 500 → shortfall = 700
  const quote = mockQuote({ gasCostWei: 1000n });

  try {
    await engine.execute(mockIntent(), quote, mockWalletClient(), mockPublicClient(500n));
  } catch { /* Expected */ }

  assert.ok(received.check);
  assert.strictEqual(received.check.userBalanceWei, 500n);
  assert.strictEqual(received.check.estimatedGasCostWei, 1200n, "Should include 20% margin");
  assert.strictEqual(received.check.shortfallWei, 700n, "1200 - 500 = 700");
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
  console.log(`\n🎉 ALL ${passed} TESTS PASSED — Gasless Swap detection is bulletproof!\n`);
}
