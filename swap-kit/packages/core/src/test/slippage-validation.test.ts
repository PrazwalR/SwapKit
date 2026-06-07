/**
 * ═══════════════════════════════════════════════════════════════════════
 *   SLIPPAGE VALIDATION — Security Regression Test Suite
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Guards the HIGH-severity finding: maxSlippageBps was never validated in the
 * live quote/swap path. A value >= 10000 bps produces a zero (or negative)
 * minOut in the Uniswap v4 adapter — silently removing ALL sandwich/slippage
 * protection. Values > 2000 bps also bypass the documented safety ceiling.
 *
 * Run: npx tsx src/test/slippage-validation.test.ts
 *
 * Coverage:
 *   SECTION 1: assertValidSlippageBps — boundary & type validation
 *   SECTION 2: normalizeIntent — live-path enforcement + defaults
 *   SECTION 3: Adapter defense-in-depth — rejection BEFORE any network call
 *   SECTION 4: minOut math invariant — valid slippage never yields minOut <= 0
 */

import assert from "node:assert";
import {
  assertValidSlippageBps,
  MIN_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
} from "../intent/parser.js";
import { normalizeIntent } from "../intent/parser.js";
import { UniswapV4Adapter } from "../adapters/uniswap-v4.js";
import { OneInchFusionAdapter } from "../adapters/one-inch.js";
import { ParaswapAdapter } from "../adapters/paraswap.js";
import type { SwapIntent } from "../types.js";

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

/** Assert that `fn` throws and the message mentions slippage. */
function assertRejectsSlippage(fn: () => void, label: string) {
  let threw = false;
  try {
    fn();
  } catch (err: any) {
    threw = true;
    assert.match(
      err.message,
      /slippage/i,
      `${label}: error should mention slippage, got: ${err.message}`
    );
  }
  assert.ok(threw, `${label}: expected a throw but none occurred`);
}

/** Assert that an async `fn` rejects with a slippage error, with NO network dependency. */
async function assertAsyncRejectsSlippage(fn: () => Promise<unknown>, label: string) {
  let threw = false;
  try {
    await fn();
  } catch (err: any) {
    threw = true;
    assert.match(
      err.message,
      /slippage/i,
      `${label}: rejection should mention slippage (i.e. it fired before any network call), got: ${err.message}`
    );
  }
  assert.ok(threw, `${label}: expected a rejection but none occurred`);
}

/** Build a same-chain mainnet intent with a given slippage. */
function rawIntent(maxSlippageBps?: number): SwapIntent {
  return {
    fromToken: "ETH",
    toToken: "USDC",
    fromAmount: 1_000_000_000_000_000_000n, // 1 ETH
    fromChainId: 1,
    ...(maxSlippageBps !== undefined ? { maxSlippageBps } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════
//   SECTION 1: assertValidSlippageBps — boundary & type validation
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║       SLIPPAGE VALIDATION — Security Regression Suite        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`  Bounds under test: [${MIN_SLIPPAGE_BPS}, ${MAX_SLIPPAGE_BPS}] bps\n`);

  console.log("──── SECTION 1: assertValidSlippageBps ────");

  await test("accepts the MIN boundary (1 bps)", () => {
    assertValidSlippageBps(MIN_SLIPPAGE_BPS);
  });
  await test("accepts the MAX boundary (2000 bps)", () => {
    assertValidSlippageBps(MAX_SLIPPAGE_BPS);
  });
  await test("accepts a typical value (50 bps)", () => {
    assertValidSlippageBps(50);
  });
  await test("accepts mid-range value (500 bps)", () => {
    assertValidSlippageBps(500);
  });

  await test("rejects 0 (would make swaps unfillable)", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(0), "zero");
  });
  await test("rejects -1 (negative)", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(-1), "negative");
  });
  await test("rejects 2001 (just above the safety ceiling)", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(MAX_SLIPPAGE_BPS + 1), "2001");
  });
  await test("rejects 9999 (high but below the zero-minOut threshold)", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(9999), "9999");
  });
  await test("rejects 10000 (THE dangerous value → minOut = 0)", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(10000), "10000");
  });
  await test("rejects 10001 (would make minOut NEGATIVE → encode throw)", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(10001), "10001");
  });
  await test("rejects 1_000_000 (absurdly large)", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(1_000_000), "huge");
  });

  await test("rejects non-integer 1.5", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(1.5), "float");
  });
  await test("rejects 49.9999 (sneaky float near valid)", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(49.9999), "near-float");
  });
  await test("rejects NaN", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(NaN), "NaN");
  });
  await test("rejects Infinity", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(Infinity), "Infinity");
  });
  await test("rejects -Infinity", () => {
    assertRejectsSlippage(() => assertValidSlippageBps(-Infinity), "-Infinity");
  });
  await test("rejects a string coerced as any ('500')", () => {
    assertRejectsSlippage(() => assertValidSlippageBps("500" as any), "string");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   SECTION 2: normalizeIntent — live-path enforcement
  // ═══════════════════════════════════════════════════════════════════════

  console.log("\n──── SECTION 2: normalizeIntent (live quote/swap path) ────");

  await test("defaults to 50 bps when omitted", () => {
    const intent = normalizeIntent(rawIntent());
    assert.strictEqual(intent.maxSlippageBps, 50);
  });
  await test("preserves a valid explicit value (100 bps)", () => {
    const intent = normalizeIntent(rawIntent(100));
    assert.strictEqual(intent.maxSlippageBps, 100);
  });
  await test("preserves the MAX boundary (2000 bps)", () => {
    const intent = normalizeIntent(rawIntent(2000));
    assert.strictEqual(intent.maxSlippageBps, 2000);
  });
  await test("rejects 0 in the live path", () => {
    assertRejectsSlippage(() => normalizeIntent(rawIntent(0)), "normalize-0");
  });
  await test("rejects 10000 in the live path (the core vuln)", () => {
    assertRejectsSlippage(() => normalizeIntent(rawIntent(10000)), "normalize-10000");
  });
  await test("rejects 2001 in the live path (bypass of ceiling)", () => {
    assertRejectsSlippage(() => normalizeIntent(rawIntent(2001)), "normalize-2001");
  });
  await test("rejects negative in the live path", () => {
    assertRejectsSlippage(() => normalizeIntent(rawIntent(-50)), "normalize-neg");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   SECTION 3: Adapter defense-in-depth (standalone usage)
  //   These MUST throw a slippage error BEFORE any network call is made.
  // ═══════════════════════════════════════════════════════════════════════

  console.log("\n──── SECTION 3: Adapter defense-in-depth (no network) ────");

  // A hand-built Required<SwapIntent> bypassing normalizeIntent entirely.
  const evilIntent = {
    fromToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    fromAmount: 1_000_000_000_000_000_000n,
    fromChainId: 1,
    toChainId: 1,
    maxSlippageBps: 10000, // dangerous
    deadline: Math.floor(Date.now() / 1000) + 1200,
    protocols: ["uniswap-v4", "1inch-fusion", "paraswap"] as any,
    skipMEVCheck: false,
    recipient: "0x0000000000000000000000000000000000000000",
  } as Required<SwapIntent>;

  await test("UniswapV4Adapter.quote rejects 10000 bps before RPC", async () => {
    await assertAsyncRejectsSlippage(
      () => new UniswapV4Adapter().quote(evilIntent),
      "uniswap-v4"
    );
  });
  await test("ParaswapAdapter.quote rejects 10000 bps before API", async () => {
    await assertAsyncRejectsSlippage(
      () => new ParaswapAdapter().quote(evilIntent),
      "paraswap"
    );
  });
  await test("OneInchFusionAdapter.quote rejects 10000 bps before API", async () => {
    // Provide a dummy key so the apiKey guard passes and we reach the slippage check.
    await assertAsyncRejectsSlippage(
      () => new OneInchFusionAdapter("dummy-key").quote(evilIntent),
      "1inch"
    );
  });

  await test("Adapter rejection also fires for 2001 bps (ceiling bypass)", async () => {
    const intent2001 = { ...evilIntent, maxSlippageBps: 2001 } as Required<SwapIntent>;
    await assertAsyncRejectsSlippage(
      () => new UniswapV4Adapter().quote(intent2001),
      "uniswap-v4-2001"
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  //   SECTION 4: minOut math invariant
  //   Proves WHY the bound matters: the exact formula used in the adapter.
  // ═══════════════════════════════════════════════════════════════════════

  console.log("\n──── SECTION 4: minOut math invariant ────");

  // Mirror of uniswap-v4 encodeSwapCalldata: minOut = amountOut * (10000 - bps) / 10000
  const minOut = (amountOut: bigint, bps: number) =>
    (amountOut * BigInt(10000 - bps)) / 10000n;

  const AMOUNT = 1_000_000_000n;

  await test("valid MAX slippage (2000) still yields a positive minOut (80%)", () => {
    const out = minOut(AMOUNT, MAX_SLIPPAGE_BPS);
    assert.ok(out > 0n, `minOut should be > 0, got ${out}`);
    assert.strictEqual(out, (AMOUNT * 8000n) / 10000n);
  });
  await test("DEMONSTRATION: 10000 bps would have yielded minOut = 0 (now blocked)", () => {
    // This is the exact unsafe outcome the validator prevents from reaching here.
    assert.strictEqual(minOut(AMOUNT, 10000), 0n);
  });
  await test("DEMONSTRATION: >10000 bps would have yielded a NEGATIVE minOut (now blocked)", () => {
    assert.ok(minOut(AMOUNT, 11000) < 0n, "minOut should be negative for 11000 bps");
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
    console.log(`\n🎉 ALL ${passed} TESTS PASSED — slippage validation is locked down!\n`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
