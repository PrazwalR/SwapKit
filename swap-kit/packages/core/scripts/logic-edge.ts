/**
 * Pure-logic edge-case suite (no network). Boundary values, high numbers, and
 * malformed inputs that MUST be rejected.
 *
 *   npx tsx scripts/logic-edge.ts
 */
import {
  normalizeIntent, assertValidSlippageBps, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS,
  calculateMinOutput, estimateOptimalSlippage, calculatePriceImpact,
} from "../src/index.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? (pass++, console.log("✅ " + m)) : (fail++, console.log("❌ " + m)); };
const throws = (fn: () => unknown, m: string) => { try { fn(); ok(false, m + " (did NOT throw)"); } catch { ok(true, m + " (threw as expected)"); } };
const nothrow = (fn: () => unknown, m: string) => { try { fn(); ok(true, m); } catch (e: any) { ok(false, m + " (threw: " + e.message + ")"); } };

console.log("── slippage bounds [" + MIN_SLIPPAGE_BPS + ", " + MAX_SLIPPAGE_BPS + "] ──");
nothrow(() => assertValidSlippageBps(1), "1 bps accepted (min)");
nothrow(() => assertValidSlippageBps(2000), "2000 bps accepted (max)");
nothrow(() => assertValidSlippageBps(50), "50 bps accepted");
throws(() => assertValidSlippageBps(0), "0 bps rejected (unfillable / no protection)");
throws(() => assertValidSlippageBps(2001), "2001 bps rejected (over ceiling)");
throws(() => assertValidSlippageBps(10000), "10000 bps rejected (zero minOut)");
throws(() => assertValidSlippageBps(-1), "-1 bps rejected");
throws(() => assertValidSlippageBps(1.5), "1.5 bps rejected (non-integer)");
throws(() => assertValidSlippageBps(NaN), "NaN rejected");
throws(() => assertValidSlippageBps("50" as any), "string '50' rejected (non-number)");

console.log("\n── normalizeIntent defaults + rejections ──");
const norm = normalizeIntent({ fromToken: "ETH", toToken: "USDC", fromAmount: 1n, fromChainId: 1 });
ok(norm.maxSlippageBps === 50, "default slippage 50");
ok(norm.recipient === "0x0000000000000000000000000000000000000000", "default recipient zero");
ok(norm.protocols.length === 3, "defaults to all 3 protocols");
ok(norm.toChainId === 1, "toChainId defaults to fromChainId");
ok(norm.fromToken.startsWith("0x") && norm.fromToken.length === 42, "ETH symbol resolved to address");
throws(() => normalizeIntent({ fromToken: "NOTATOKEN", toToken: "USDC", fromAmount: 1n, fromChainId: 1 }), "unknown token symbol rejected");
throws(() => normalizeIntent({ fromToken: "ETH", toToken: "USDC", fromAmount: 1n, fromChainId: 1, maxSlippageBps: 2001 }), "intent slippage 2001 rejected");
throws(() => normalizeIntent({ fromToken: "ETH", toToken: "USDC", fromAmount: 1n, fromChainId: 1, maxSlippageBps: 0 }), "intent slippage 0 rejected");

console.log("\n── calculateMinOutput math + high numbers ──");
ok(calculateMinOutput(1_000_000n, 50) === 995_000n, "1e6 @ 50bps = 995000");
ok(calculateMinOutput(1_000_000n, 0) === 1_000_000n, "0 slippage = full amount");
ok(calculateMinOutput(1_000_000n, 10000) === 0n, "10000 bps = 0 minOut");
throws(() => calculateMinOutput(1n, 10001), "slippage > 10000 rejected");
throws(() => calculateMinOutput(1n, -1), "negative slippage rejected");
// High number: 1e30 wei, exact bigint math, no float precision loss
const huge = 10n ** 30n;
ok(calculateMinOutput(huge, 50) === huge * 9950n / 10000n, "1e30 @ 50bps exact (no precision loss)");

console.log("\n── estimateOptimalSlippage / priceImpact edges ──");
ok(estimateOptimalSlippage(1n, 0n) === 200, "zero liquidity → 2% default");
ok(estimateOptimalSlippage(1n, 10n ** 24n) === 10, "tiny trade vs deep pool → 0.1%");
ok(calculatePriceImpact(0n, 100n, 5n) === 0, "zero input → 0 impact");
ok(calculatePriceImpact(100n, 100n, 0n) === 0, "zero spot price → 0 impact");

console.log(`\n──── ${pass} passed, ${fail} failed ────`);
process.exit(fail > 0 ? 1 : 0);
