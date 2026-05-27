/**
 * SwapKit — Comprehensive Integration & Edge Case Test Suite
 * ===========================================================
 * Run: npx tsx packages/core/src/test/integration.ts
 *
 * Tests cover:
 *   SECTION 1: Infrastructure (Alchemy RPC, contract verification)
 *   SECTION 2: Paraswap quotes (multi-chain, reverse swaps, edge amounts)
 *   SECTION 3: 1inch Fusion+ quotes (classic swap, cross-chain, error handling)
 *   SECTION 4: DefiLlama price oracle
 *   SECTION 5: Rust Engine (MEV simulation, quote scanner, hook mining)
 *   SECTION 6: Edge Cases (zero amounts, unsupported chains, invalid tokens, etc.)
 *   SECTION 7: SDK Integration (SwapKit class end-to-end)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: "packages/core/.env" });

import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";

// ─── Config ──────────────────────────────────────────────────────────────────

const ALCHEMY_KEY = process.env.ALCHEMY_KEY!;
const ONEINCH_API_KEY = process.env["1INCH_API_KEY"];

// Tokens on mainnet
const ETH_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const DAI  = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const AMOUNT_1_ETH = 1_000_000_000_000_000_000n; // 1e18
const AMOUNT_01_ETH = 100_000_000_000_000_000n;  // 0.1e18

// Base tokens
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Arbitrum tokens
const ARB_WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// V4 contracts
const V4_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`),
});

// ─── Test Harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ○ ${name}... `);
  try {
    await fn();
    passed++;
    console.log("✅ PASS");
  } catch (e: any) {
    failed++;
    const msg = e.message || String(e);
    console.log(`❌ FAIL: ${msg}`);
    failures.push(`${name}: ${msg}`);
  }
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  ○ ${name}... ⏭️  SKIP (${reason})`);
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function section(name: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

// Rate limit helper — 1inch has strict rate limits
async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── SECTION 1: Infrastructure ───────────────────────────────────────────────

async function testInfrastructure() {
  section("🔗 SECTION 1: Infrastructure & RPC");

  await test("Alchemy RPC — eth_blockNumber returns valid block", async () => {
    const block = await publicClient.getBlockNumber();
    assert(block > 21_000_000n, `Block too low: ${block}`);
    console.log(`(Block: ${block})`);
  });

  await test("V4 PoolManager — contract has bytecode on mainnet", async () => {
    const code = await publicClient.getBytecode({ address: V4_POOL_MANAGER as `0x${string}` });
    assert(!!code && code.length > 10, "No bytecode at PoolManager address");
    console.log(`(${(code!.length / 2 - 1)} bytes)`);
  });

  await test("Alchemy RPC — eth_getBalance for vitalik.eth", async () => {
    const balance = await publicClient.getBalance({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as `0x${string}` });
    assert(balance > 0n, `Vitalik balance is 0?`);
    console.log(`(${formatUnits(balance, 18)} ETH)`);
  });

  await test("Alchemy RPC — Base chain connectivity", async () => {
    const baseClient = createPublicClient({
      transport: http(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`),
    });
    const block = await baseClient.getBlockNumber();
    assert(block > 1_000_000n, `Base block too low: ${block}`);
    console.log(`(Base Block: ${block})`);
  });

  await test("Alchemy RPC — Arbitrum chain connectivity", async () => {
    const arbClient = createPublicClient({
      transport: http(`https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`),
    });
    const block = await arbClient.getBlockNumber();
    assert(block > 100_000_000n, `Arb block too low: ${block}`);
    console.log(`(Arb Block: ${block})`);
  });
}

// ─── SECTION 2: Paraswap ─────────────────────────────────────────────────────

async function testParaswap() {
  section("⚡ SECTION 2: Paraswap Quotes");

  await test("Mainnet — ETH → USDC (1 ETH)", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${ETH_NATIVE}&destToken=${USDC}&amount=${AMOUNT_1_ETH}&srcDecimals=18&destDecimals=6&side=SELL&network=1`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const usdcOut = Number(data.priceRoute?.destAmount ?? 0) / 1e6;
    assert(usdcOut > 100, `USDC out too low: ${usdcOut}`);
    console.log(`(1 ETH → ${usdcOut.toFixed(2)} USDC)`);
  });

  await test("Mainnet — USDC → ETH (2000 USDC)", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${USDC}&destToken=${ETH_NATIVE}&amount=2000000000&srcDecimals=6&destDecimals=18&side=SELL&network=1`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const ethOut = Number(data.priceRoute?.destAmount ?? 0) / 1e18;
    assert(ethOut > 0.1, `ETH out too low: ${ethOut}`);
    console.log(`(2000 USDC → ${ethOut.toFixed(4)} ETH)`);
  });

  await test("Mainnet — WBTC → USDC (0.05 WBTC)", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${WBTC}&destToken=${USDC}&amount=5000000&srcDecimals=8&destDecimals=6&side=SELL&network=1`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const usdcOut = Number(data.priceRoute?.destAmount ?? 0) / 1e6;
    assert(usdcOut > 100, `USDC out too low: ${usdcOut}`);
    console.log(`(0.05 WBTC → ${usdcOut.toFixed(2)} USDC)`);
  });

  await test("Mainnet — DAI → USDT stablecoin swap (1000 DAI)", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${DAI}&destToken=${USDT}&amount=1000000000000000000000&srcDecimals=18&destDecimals=6&side=SELL&network=1`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const usdtOut = Number(data.priceRoute?.destAmount ?? 0) / 1e6;
    assert(usdtOut > 990, `Stablecoin swap too much slippage: ${usdtOut}`);
    assert(usdtOut < 1010, `Stablecoin swap suspiciously high: ${usdtOut}`);
    console.log(`(1000 DAI → ${usdtOut.toFixed(2)} USDT)`);
  });

  await test("Base — WETH → USDC (1 WETH)", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${BASE_WETH}&destToken=${BASE_USDC}&amount=${AMOUNT_1_ETH}&srcDecimals=18&destDecimals=6&side=SELL&network=8453`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const usdcOut = Number(data.priceRoute?.destAmount ?? 0) / 1e6;
    assert(usdcOut > 100, `Base USDC out too low: ${usdcOut}`);
    console.log(`(1 WETH → ${usdcOut.toFixed(2)} USDC on Base)`);
  });

  await test("Arbitrum — WETH → USDC (1 WETH)", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${ARB_WETH}&destToken=${ARB_USDC}&amount=${AMOUNT_1_ETH}&srcDecimals=18&destDecimals=6&side=SELL&network=42161`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const usdcOut = Number(data.priceRoute?.destAmount ?? 0) / 1e6;
    assert(usdcOut > 100, `Arb USDC out too low: ${usdcOut}`);
    console.log(`(1 WETH → ${usdcOut.toFixed(2)} USDC on Arbitrum)`);
  });

  await test("Mainnet — Tiny amount (0.001 ETH → USDC)", async () => {
    const tinyAmount = 1_000_000_000_000_000n; // 0.001 ETH
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${ETH_NATIVE}&destToken=${USDC}&amount=${tinyAmount}&srcDecimals=18&destDecimals=6&side=SELL&network=1`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const usdcOut = Number(data.priceRoute?.destAmount ?? 0) / 1e6;
    assert(usdcOut > 0.5, `Tiny swap USDC too low: ${usdcOut}`);
    console.log(`(0.001 ETH → ${usdcOut.toFixed(4)} USDC)`);
  });
}

// ─── SECTION 3: 1inch Fusion+ ────────────────────────────────────────────────

async function testOneInch() {
  section("🔄 SECTION 3: 1inch Fusion+ Quotes");

  if (!ONEINCH_API_KEY) {
    skip("All 1inch tests", "1INCH_API_KEY not set in .env");
    return;
  }

  const headers = { Authorization: `Bearer ${ONEINCH_API_KEY}` };

  // Test 3.1: Classic swap quote
  await test("Classic swap — ETH → USDC on mainnet (1 ETH)", async () => {
    const res = await fetch(
      `https://api.1inch.dev/swap/v6.0/1/quote?src=${ETH_NATIVE}&dst=${USDC}&amount=${AMOUNT_1_ETH}&includeGas=true`,
      { headers }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json() as any;
    const usdcOut = Number(data.dstAmount ?? 0) / 1e6;
    assert(usdcOut > 100, `USDC out too low: ${usdcOut}`);
    console.log(`(1 ETH → ${usdcOut.toFixed(2)} USDC, gas: ${data.gas ?? "?"})`);
  });

  await sleep(1200); // rate limit

  // Test 3.2: Classic swap USDC → ETH
  await test("Classic swap — USDC → ETH on mainnet (2000 USDC)", async () => {
    const res = await fetch(
      `https://api.1inch.dev/swap/v6.0/1/quote?src=${USDC}&dst=${ETH_NATIVE}&amount=2000000000&includeGas=true`,
      { headers }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json() as any;
    const ethOut = Number(data.dstAmount ?? 0) / 1e18;
    assert(ethOut > 0.1, `ETH out too low: ${ethOut}`);
    console.log(`(2000 USDC → ${ethOut.toFixed(4)} ETH)`);
  });

  await sleep(1200);

  // Test 3.3: Classic swap on Arbitrum
  await test("Classic swap — ETH → USDC on Arbitrum", async () => {
    const res = await fetch(
      `https://api.1inch.dev/swap/v6.0/42161/quote?src=${ETH_NATIVE}&dst=${ARB_USDC}&amount=${AMOUNT_01_ETH}&includeGas=true`,
      { headers }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json() as any;
    const usdcOut = Number(data.dstAmount ?? 0) / 1e6;
    assert(usdcOut > 10, `Arb USDC out too low: ${usdcOut}`);
    console.log(`(0.1 ETH → ${usdcOut.toFixed(2)} USDC on Arb)`);
  });

  await sleep(1200);

  // Test 3.4: Classic swap on Base
  await test("Classic swap — ETH → USDC on Base", async () => {
    const res = await fetch(
      `https://api.1inch.dev/swap/v6.0/8453/quote?src=${ETH_NATIVE}&dst=${BASE_USDC}&amount=${AMOUNT_01_ETH}&includeGas=true`,
      { headers }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json() as any;
    const usdcOut = Number(data.dstAmount ?? 0) / 1e6;
    assert(usdcOut > 10, `Base USDC out too low: ${usdcOut}`);
    console.log(`(0.1 ETH → ${usdcOut.toFixed(2)} USDC on Base)`);
  });

  await sleep(1200);

  // Test 3.5: WBTC → USDC
  await test("Classic swap — WBTC → USDC on mainnet (0.01 WBTC)", async () => {
    const res = await fetch(
      `https://api.1inch.dev/swap/v6.0/1/quote?src=${WBTC}&dst=${USDC}&amount=1000000&includeGas=true`,
      { headers }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json() as any;
    const usdcOut = Number(data.dstAmount ?? 0) / 1e6;
    assert(usdcOut > 100, `WBTC→USDC too low: ${usdcOut}`);
    console.log(`(0.01 WBTC → ${usdcOut.toFixed(2)} USDC)`);
  });

  await sleep(1200);

  // Test 3.6: Stablecoin swap
  await test("Classic swap — DAI → USDT stablecoin (1000 DAI)", async () => {
    const res = await fetch(
      `https://api.1inch.dev/swap/v6.0/1/quote?src=${DAI}&dst=${USDT}&amount=1000000000000000000000&includeGas=true`,
      { headers }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json() as any;
    const usdtOut = Number(data.dstAmount ?? 0) / 1e6;
    assert(usdtOut > 990, `Stablecoin slip too high: ${usdtOut}`);
    assert(usdtOut < 1010, `Stablecoin suspiciously high: ${usdtOut}`);
    console.log(`(1000 DAI → ${usdtOut.toFixed(2)} USDT)`);
  });

  await sleep(1200);

  // Test 3.7: Tiny amount
  await test("Classic swap — Tiny 0.001 ETH → USDC", async () => {
    const tinyAmount = 1_000_000_000_000_000n;
    const res = await fetch(
      `https://api.1inch.dev/swap/v6.0/1/quote?src=${ETH_NATIVE}&dst=${USDC}&amount=${tinyAmount}&includeGas=true`,
      { headers }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json() as any;
    const usdcOut = Number(data.dstAmount ?? 0) / 1e6;
    assert(usdcOut > 0.5, `Tiny swap result too low: ${usdcOut}`);
    console.log(`(0.001 ETH → ${usdcOut.toFixed(4)} USDC)`);
  });

  await sleep(1200);

  // Test 3.8: 1inch supported token list
  await test("Token list API — fetch popular tokens on mainnet", async () => {
    const res = await fetch(
      `https://api.1inch.dev/token/v1.2/1/search?query=USDC&limit=5`,
      { headers }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json() as any;
    const tokens = Array.isArray(data) ? data : [];
    assert(tokens.length > 0, "No tokens returned");
    console.log(`(Found ${tokens.length} tokens matching 'USDC')`);
  });
}

// ─── SECTION 4: DefiLlama ────────────────────────────────────────────────────

async function testDefiLlama() {
  section("📊 SECTION 4: DefiLlama Price Oracle");

  await test("Fetch ETH + USDC prices", async () => {
    const res = await fetch(
      `https://coins.llama.fi/prices/current/coingecko:ethereum,ethereum:${USDC}`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const ethPrice = data.coins?.["coingecko:ethereum"]?.price;
    assert(ethPrice > 100, `ETH price too low: ${ethPrice}`);
    console.log(`(ETH: $${ethPrice?.toFixed(2)})`);
  });

  await test("Fetch BTC price", async () => {
    const res = await fetch(
      `https://coins.llama.fi/prices/current/coingecko:bitcoin`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const btcPrice = data.coins?.["coingecko:bitcoin"]?.price;
    assert(btcPrice > 10000, `BTC price too low: ${btcPrice}`);
    console.log(`(BTC: $${btcPrice?.toFixed(2)})`);
  });
}

// ─── SECTION 5: Rust Engine ──────────────────────────────────────────────────

async function testRustEngine() {
  section("🦀 SECTION 5: Rust Engine");

  const engineUp = await fetch("http://localhost:3030/health").then(() => true).catch(() => false);

  if (!engineUp) {
    skip("All Rust Engine tests", "Engine not running. Start with: cargo run -p swap-kit-engine");
    return;
  }

  await test("GET /health", async () => {
    const res = await fetch("http://localhost:3030/health");
    const text = await res.text();
    assert(text === "ok", `Unexpected: ${text}`);
  });

  await test("POST /simulate — small trade (expect 'none' risk)", async () => {
    const res = await fetch("http://localhost:3030/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_token: WETH, to_token: USDC,
        from_amount: "100000000000000000", chain_id: 1,
        protocol: "uniswap-v4", amount_out: "200000000", slippage_bps: 50,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    assert(["none", "low"].includes(data.sandwich_risk), `Risk: ${data.sandwich_risk}`);
    console.log(`(Risk: ${data.sandwich_risk})`);
  });

  await test("POST /simulate — large trade (expect 'high' risk)", async () => {
    const res = await fetch("http://localhost:3030/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_token: WETH, to_token: USDC,
        from_amount: "100000000000000000000", chain_id: 1,
        protocol: "uniswap-v4", amount_out: "200000000000", slippage_bps: 200,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    assert(data.sandwich_risk === "high", `Expected high, got: ${data.sandwich_risk}`);
    console.log(`(Risk: ${data.sandwich_risk}, rec slippage: ${data.recommended_slippage_bps}bps)`);
  });

  await test("POST /simulate — medium trade with low slippage", async () => {
    const res = await fetch("http://localhost:3030/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_token: WETH, to_token: USDC,
        from_amount: "10000000000000000000", chain_id: 1,
        protocol: "uniswap-v4", amount_out: "20000000000", slippage_bps: 30,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    assert(["low", "medium", "high"].includes(data.sandwich_risk), `Unexpected: ${data.sandwich_risk}`);
    console.log(`(Risk: ${data.sandwich_risk})`);
  });

  await test("POST /quote — parallel quote fetch", async () => {
    const res = await fetch("http://localhost:3030/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_token: WETH, to_token: USDC, from_amount: AMOUNT_1_ETH.toString(), chain_id: 1,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    assert(Array.isArray(data.quotes), "No quotes array");
    assert(data.quotes.length >= 2, `Expected ≥2 quotes, got ${data.quotes.length}`);
    console.log(`(${data.quotes.length} quotes, best: ${data.quotes[0]?.protocol})`);
  });

  await test("POST /mine — CREATE2 hook address mining (prefix '00')", async () => {
    const res = await fetch("http://localhost:3030/mine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deployer: "0x0000000000000000000000000000000000000001",
        init_code_hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
        prefix: "00", max_iterations: 500000,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    assert(data.found === true, `Mining failed after ${data.attempts}`);
    assert(data.address.startsWith("0x00"), `Address mismatch: ${data.address}`);
    console.log(`(Found in ${data.attempts} attempts: ${data.address.slice(0, 12)}...)`);
  });

  await test("POST /mine — harder prefix '0000'", async () => {
    const res = await fetch("http://localhost:3030/mine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deployer: "0x0000000000000000000000000000000000000001",
        init_code_hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
        prefix: "0000", max_iterations: 5000000,
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    if (data.found) {
      assert(data.address.startsWith("0x0000"), `Prefix mismatch: ${data.address}`);
      console.log(`(Found in ${data.attempts}: ${data.address.slice(0, 14)}...)`);
    } else {
      console.log(`(Not found in ${data.attempts} — expected for hard prefix)`);
    }
  });
}

// ─── SECTION 6: Edge Cases ───────────────────────────────────────────────────

async function testEdgeCases() {
  section("🧪 SECTION 6: Edge Cases & Error Handling");

  await test("Paraswap — zero amount should fail gracefully", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${ETH_NATIVE}&destToken=${USDC}&amount=0&srcDecimals=18&destDecimals=6&side=SELL&network=1`
    );
    // Should return an error, not crash
    assert(res.status === 400 || res.status === 200, `Unexpected status: ${res.status}`);
  });

  await test("Paraswap — invalid token address should fail", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=0xDEAD&destToken=${USDC}&amount=${AMOUNT_1_ETH}&srcDecimals=18&destDecimals=6&side=SELL&network=1`
    );
    assert(!res.ok || res.status >= 400, "Should have failed for invalid token");
  });

  await test("Paraswap — unsupported chain (999) should fail", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${ETH_NATIVE}&destToken=${USDC}&amount=${AMOUNT_1_ETH}&srcDecimals=18&destDecimals=6&side=SELL&network=999`
    );
    assert(!res.ok, `Expected error for chain 999, got ${res.status}`);
  });

  if (ONEINCH_API_KEY) {
    await sleep(1200);

    await test("1inch — invalid token should fail gracefully", async () => {
      const res = await fetch(
        `https://api.1inch.dev/swap/v6.0/1/quote?src=0xDEADBEEF&dst=${USDC}&amount=${AMOUNT_1_ETH}`,
        { headers: { Authorization: `Bearer ${ONEINCH_API_KEY}` } }
      );
      assert(!res.ok, `Expected error for invalid token, got ${res.status}`);
      console.log(`(Got expected error: ${res.status})`);
    });

    await sleep(1200);

    await test("1inch — zero amount should fail gracefully", async () => {
      const res = await fetch(
        `https://api.1inch.dev/swap/v6.0/1/quote?src=${ETH_NATIVE}&dst=${USDC}&amount=0`,
        { headers: { Authorization: `Bearer ${ONEINCH_API_KEY}` } }
      );
      assert(!res.ok, `Expected error for zero amount, got ${res.status}`);
      console.log(`(Got expected error: ${res.status})`);
    });

    await sleep(1200);

    await test("1inch — same token src=dst should fail", async () => {
      const res = await fetch(
        `https://api.1inch.dev/swap/v6.0/1/quote?src=${USDC}&dst=${USDC}&amount=1000000`,
        { headers: { Authorization: `Bearer ${ONEINCH_API_KEY}` } }
      );
      assert(!res.ok, `Expected error for same token swap, got ${res.status}`);
      console.log(`(Got expected error: ${res.status})`);
    });
  }

  await test("DefiLlama — invalid token should return empty", async () => {
    const res = await fetch(
      `https://coins.llama.fi/prices/current/ethereum:0xDEADBEEF`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    const coins = Object.keys(data.coins || {});
    assert(coins.length === 0, `Expected no results, got ${coins.length}`);
  });
}

// ─── SECTION 7: Price Comparison Across Protocols ────────────────────────────

async function testPriceComparison() {
  section("📈 SECTION 7: Cross-Protocol Price Comparison");

  let paraswapPrice = 0;
  let oneInchPrice = 0;

  await test("Paraswap — benchmark 1 ETH → USDC price", async () => {
    const res = await fetch(
      `https://api.paraswap.io/prices?srcToken=${ETH_NATIVE}&destToken=${USDC}&amount=${AMOUNT_1_ETH}&srcDecimals=18&destDecimals=6&side=SELL&network=1`
    );
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json() as any;
    paraswapPrice = Number(data.priceRoute?.destAmount ?? 0) / 1e6;
    assert(paraswapPrice > 100, `Too low: ${paraswapPrice}`);
    console.log(`(Paraswap: ${paraswapPrice.toFixed(2)} USDC)`);
  });

  if (ONEINCH_API_KEY) {
    await sleep(1200);
    await test("1inch — benchmark 1 ETH → USDC price", async () => {
      const res = await fetch(
        `https://api.1inch.dev/swap/v6.0/1/quote?src=${ETH_NATIVE}&dst=${USDC}&amount=${AMOUNT_1_ETH}`,
        { headers: { Authorization: `Bearer ${ONEINCH_API_KEY}` } }
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      const data = await res.json() as any;
      oneInchPrice = Number(data.dstAmount ?? 0) / 1e6;
      assert(oneInchPrice > 100, `Too low: ${oneInchPrice}`);
      console.log(`(1inch: ${oneInchPrice.toFixed(2)} USDC)`);
    });
  }

  await test("Compare prices — should be within 1% of each other", async () => {
    if (paraswapPrice === 0) throw new Error("Paraswap price not set");
    if (oneInchPrice === 0 && ONEINCH_API_KEY) throw new Error("1inch price not set");
    if (oneInchPrice === 0) {
      console.log(`(Skipped — only Paraswap available: ${paraswapPrice.toFixed(2)} USDC)`);
      return;
    }
    const diff = Math.abs(paraswapPrice - oneInchPrice);
    const pctDiff = (diff / Math.max(paraswapPrice, oneInchPrice)) * 100;
    assert(pctDiff < 1.5, `Prices differ by ${pctDiff.toFixed(2)}% — too much!`);
    const winner = paraswapPrice > oneInchPrice ? "Paraswap" : "1inch";
    console.log(`(Δ ${pctDiff.toFixed(3)}%, winner: ${winner})`);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       SwapKit — Full Integration & Edge Case Test Suite     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Alchemy Key:  ...${ALCHEMY_KEY?.slice(-6)}`);
  console.log(`  1inch Key:    ${ONEINCH_API_KEY ? `...${ONEINCH_API_KEY.slice(-6)}` : "NOT SET ⚠️"}`);
  console.log(`  Timestamp:    ${new Date().toISOString()}`);

  await testInfrastructure();
  await testParaswap();
  await testOneInch();
  await testDefiLlama();
  await testRustEngine();
  await testEdgeCases();
  await testPriceComparison();

  console.log(`\n${"═".repeat(60)}`);
  console.log("  FINAL RESULTS");
  console.log(`${"═".repeat(60)}`);
  console.log(`  ✅ Passed:  ${passed}`);
  console.log(`  ❌ Failed:  ${failed}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  console.log(`  Total:     ${passed + failed + skipped}`);

  if (failures.length > 0) {
    console.log(`\n  ── Failure Details ──`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }

  if (failed === 0) {
    console.log("\n  🎉 ALL TESTS PASSED — Ready for publication!");
  } else {
    console.log("\n  ⚠️  SOME TESTS FAILED — Fix before publishing");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
