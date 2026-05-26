/**
 * Integration tests for swap-kit adapters
 * Run: npx tsx packages/core/src/test/integration.ts
 *
 * Tests run against mainnet (read-only quote calls, no signing/execution).
 * Set ONE_INCH_API_KEY in .env to test 1inch.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: "packages/core/.env" });

import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";

// ─── Config ──────────────────────────────────────────────────────────────────

const ALCHEMY_KEY = process.env.ALCHEMY_KEY!;
const ONE_INCH_API_KEY = process.env.ONE_INCH_API_KEY;

// Tokens on mainnet
const ETH_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AMOUNT_1_ETH = 1_000_000_000_000_000_000n; // 1e18

// V4 contracts
const V4_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const V4_STATE_VIEW = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597ea0";
const V4_QUOTER = "0x52f0e24d1c21c8a0cb1e5a5dD62ce9D24b345Ea3"; // V4 quoter

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ○ ${name}... `);
  try {
    await fn();
    passed++;
    console.log("✅ PASS");
  } catch (e: any) {
    failed++;
    console.log(`❌ FAIL: ${e.message}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testAlchemy() {
  console.log("\n🔗 Alchemy RPC");
  await test("eth_blockNumber returns valid block", async () => {
    const block = await publicClient.getBlockNumber();
    assert(block > 21_000_000n, `Block too low: ${block}`);
    console.log(`\n      Block: ${block}`);
  });

  await test("V4 PoolManager has code", async () => {
    const code = await publicClient.getBytecode({ address: V4_POOL_MANAGER as `0x${string}` });
    assert(!!code && code.length > 10, "No bytecode at PoolManager address");
    console.log(`\n      PoolManager bytecode: ${(code?.length ?? 0) / 2 - 1} bytes`);
  });
}

async function testParaswap() {
  console.log("\n⚡ Paraswap / Velora");

  await test("Quote ETH → USDC on mainnet", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${ETH_NATIVE}&destToken=${USDC}&amount=${AMOUNT_1_ETH.toString()}&srcDecimals=18&destDecimals=6&side=SELL&network=1`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const route = data.priceRoute;
    assert(!!route?.destAmount, "No destAmount in response");
    const usdcOut = Number(route.destAmount) / 1e6;
    assert(usdcOut > 100, `USDC out suspiciously low: ${usdcOut}`);
    console.log(`\n      1 ETH → ${usdcOut.toFixed(2)} USDC via ${route.bestRoute?.[0]?.swaps?.[0]?.swapExchanges?.[0]?.exchange ?? "?"}`);
  });

  await test("Quote USDC → ETH on mainnet", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${USDC}&destToken=${ETH_NATIVE}&amount=2000000000&srcDecimals=6&destDecimals=18&side=SELL&network=1`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const ethOut = Number(data.priceRoute?.destAmount ?? 0) / 1e18;
    assert(ethOut > 0.1, `ETH out suspiciously low: ${ethOut}`);
    console.log(`\n      2000 USDC → ${ethOut.toFixed(4)} ETH`);
  });

  await test("Quote on Base (chain 8453)", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=0x4200000000000000000000000000000000000006&destToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amount=${AMOUNT_1_ETH.toString()}&srcDecimals=18&destDecimals=6&side=SELL&network=8453`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const usdcOut = Number(data.priceRoute?.destAmount ?? 0) / 1e6;
    assert(usdcOut > 100, `USDC out on Base too low: ${usdcOut}`);
    console.log(`\n      1 WETH → ${usdcOut.toFixed(2)} USDC (Base)`);
  });
}

async function testOneInch() {
  console.log("\n🔄 1inch Fusion+");

  if (!ONE_INCH_API_KEY || ONE_INCH_API_KEY === "YOUR_1INCH_KEY") {
    console.log("  ⚠️  ONE_INCH_API_KEY not set — skipping 1inch tests");
    return;
  }

  const headers = { Authorization: `Bearer ${ONE_INCH_API_KEY}` };

  await test("Classic swap quote ETH → USDC (chain 1)", async () => {
    const res = await fetch(
      `https://api.1inch.dev/swap/v6.0/1/quote?src=${ETH_NATIVE}&dst=${USDC}&amount=${AMOUNT_1_ETH.toString()}&from=0x0000000000000000000000000000000000000001`,
      { headers }
    );
    assert(res.ok, `HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    const usdcOut = Number(data.dstAmount ?? data.toTokenAmount ?? 0) / 1e6;
    assert(usdcOut > 100, `USDC out too low: ${usdcOut}`);
    console.log(`\n      1 ETH → ${usdcOut.toFixed(2)} USDC via 1inch classic`);
  });

  await test("Fusion+ cross-chain quote ETH mainnet → USDC Base", async () => {
    const res = await fetch(
      `https://api.1inch.dev/fusion-plus/quoter/v1.0/quote/receive?srcChain=1&dstChain=8453&srcTokenAddress=${ETH_NATIVE}&dstTokenAddress=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amount=${AMOUNT_1_ETH.toString()}&walletAddress=0x0000000000000000000000000000000000000001&enableEstimate=false`,
      { headers }
    );
    const text = await res.text();
    assert(res.ok, `HTTP ${res.status}: ${text}`);
    const data = JSON.parse(text);
    const usdcOut = Number(data.dstTokenAmount ?? 0) / 1e6;
    assert(usdcOut > 100, `Cross-chain USDC out too low: ${usdcOut}`);
    console.log(`\n      1 ETH (mainnet) → ${usdcOut.toFixed(2)} USDC (Base) via Fusion+`);
  });
}

async function testDefiLlama() {
  console.log("\n📊 DefiLlama (no-key)");

  await test("Get ETH price", async () => {
    const res = await fetch(
      `https://coins.llama.fi/prices/current/coingecko:ethereum,ethereum:${USDC}`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const ethPrice = data.coins?.["coingecko:ethereum"]?.price;
    assert(ethPrice > 100, `ETH price suspiciously low: ${ethPrice}`);
    console.log(`\n      ETH: $${ethPrice?.toFixed(2)}, USDC: $${data.coins?.[`ethereum:${USDC}`]?.price?.toFixed(4)}`);
  });
}

async function testRustEngine() {
  console.log("\n🦀 Rust Engine (http://localhost:3030)");

  await test("GET /health", async () => {
    const res = await fetch("http://localhost:3030/health").catch(() => null);
    if (!res) {
      throw new Error("Engine not running. Start with: cargo run -p swap-kit-engine");
    }
    const text = await res.text();
    assert(text === "ok", `Unexpected health response: ${text}`);
  });

  await test("POST /simulate — small trade (expect 'none' risk)", async () => {
    const res = await fetch("http://localhost:3030/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_token: WETH,
        to_token: USDC,
        from_amount: "100000000000000000", // 0.1 ETH
        chain_id: 1,
        protocol: "uniswap-v4",
        amount_out: "200000000", // 200 USDC
        slippage_bps: 50,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    assert(["none", "low"].includes(data.sandwich_risk), `Unexpected risk: ${data.sandwich_risk}`);
    console.log(`\n      Risk: ${data.sandwich_risk}, MEV est: ${data.estimated_mev_wei} wei`);
  });

  await test("POST /simulate — large trade (expect 'high' risk)", async () => {
    const res = await fetch("http://localhost:3030/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_token: WETH,
        to_token: USDC,
        from_amount: "100000000000000000000", // 100 ETH
        chain_id: 1,
        protocol: "uniswap-v4",
        amount_out: "200000000000", // 200k USDC
        slippage_bps: 200,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    assert(data.sandwich_risk === "high", `Expected high risk, got: ${data.sandwich_risk}`);
    console.log(`\n      Risk: ${data.sandwich_risk}, slippage rec: ${data.recommended_slippage_bps}bps`);
  });

  await test("POST /quote — parallel quote fetch", async () => {
    const res = await fetch("http://localhost:3030/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_token: WETH,
        to_token: USDC,
        from_amount: AMOUNT_1_ETH.toString(),
        chain_id: 1,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    assert(Array.isArray(data.quotes), "No quotes array");
    assert(data.quotes.length >= 2, `Expected ≥2 quotes, got ${data.quotes.length}`);
    console.log(`\n      Got ${data.quotes.length} quotes. Best: ${data.quotes[0]?.protocol} (${data.quotes[0]?.amount_out} out)`);
  });

  await test("POST /mine — CREATE2 hook address mining", async () => {
    const res = await fetch("http://localhost:3030/mine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deployer: "0x0000000000000000000000000000000000000001",
        init_code_hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
        prefix: "00",
        max_iterations: 500000,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    assert(data.found === true, `Mining failed after ${data.attempts} attempts`);
    assert(data.address.startsWith("0x00"), `Address doesn't match prefix: ${data.address}`);
    console.log(`\n      Found after ${data.attempts} attempts: ${data.address}`);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   swap-kit Integration Test Suite    ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`  Alchemy Key: ...${ALCHEMY_KEY?.slice(-6)}`);
  console.log(`  1inch Key: ${ONE_INCH_API_KEY ? `...${ONE_INCH_API_KEY.slice(-6)}` : "NOT SET"}`);

  await testAlchemy();
  await testParaswap();
  await testOneInch();
  await testDefiLlama();
  await testRustEngine();

  console.log("\n─────────────────────────────────────");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("  🎉 All tests passed!");
  } else {
    console.log("  ⚠️  Some tests failed — check output above");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
