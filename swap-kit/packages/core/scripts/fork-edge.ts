/**
 * Fork E2E edge matrix. GOOD cases must execute; WRONG cases must throw (never
 * silently succeed). Run against an anvil mainnet fork:
 *
 *   anvil --fork-url $RPC_ETHEREUM --port 8545 --silent &
 *   RPC_ETHEREUM=http://127.0.0.1:8545 npx tsx scripts/fork-edge.ts
 */
import { createWalletClient, createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { createSwapKit, UniswapV4Adapter, ExecutionEngine, normalizeIntent } from "../src/index.js";
import { getTokenBalance } from "../src/utils/token.js";

const ANVIL = "http://127.0.0.1:8545";
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil acct #1

const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({ account, chain: mainnet, transport: http(ANVIL) });
const publicClient = createPublicClient({ chain: mainnet, transport: http(ANVIL) });
const sdk = createSwapKit({ oneInchApiKey: "", flashbotsEnabled: false });
const adapter = new UniswapV4Adapter();
const engine = new ExecutionEngine([adapter], { flashbotsEnabled: false });

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? (pass++, console.log("✅ " + m)) : (fail++, console.log("❌ " + m)); };
async function expectOk(fn: () => Promise<boolean>, m: string) {
  try { ok(await fn(), m); } catch (e: any) { ok(false, m + " (unexpected throw: " + (e.shortMessage || e.message) + ")"); }
}
async function expectThrow(fn: () => Promise<unknown>, m: string) {
  try { await fn(); ok(false, m + " (did NOT throw!)"); } catch (e: any) { ok(true, m + " (threw: " + String(e.shortMessage || e.message).slice(0, 70) + ")"); }
}

async function swapUni(fromToken: string, toToken: string, amount: bigint) {
  const intent = normalizeIntent({ fromToken, toToken, fromAmount: amount, fromChainId: 1, protocols: ["uniswap-v4"], skipMEVCheck: true });
  const quote = await adapter.quote(intent);
  return engine.execute(intent, quote, walletClient as any, publicClient as any);
}

async function main() {
  console.log("── GOOD: must execute ──");
  await expectOk(async () => {
    const before = await getTokenBalance(USDC, account.address, publicClient as any);
    await swapUni(ETH, USDC, 50_000000000000000000n); // 50 ETH
    const after = await getTokenBalance(USDC, account.address, publicClient as any);
    console.log(`   50 ETH→USDC Δ=${formatUnits(after - before, 6)} USDC`);
    return after > before;
  }, "LARGE 50 ETH → USDC executes");

  await expectOk(async () => {
    const before = await getTokenBalance(USDC, account.address, publicClient as any);
    await swapUni(ETH, USDC, 100000000000000n); // 0.0001 ETH
    const after = await getTokenBalance(USDC, account.address, publicClient as any);
    console.log(`   0.0001 ETH→USDC Δ=${formatUnits(after - before, 6)} USDC`);
    return after > before;
  }, "TINY 0.0001 ETH → USDC executes");

  await expectOk(async () => {
    const quotes = await sdk.quote({ fromToken: ETH, toToken: USDC, fromAmount: 1_000000000000000000n, fromChainId: 1, skipMEVCheck: true });
    console.log(`   multi-protocol returned ${quotes.length} quote(s): ${quotes.map(q => q.protocol).join(", ")}`);
    return quotes.length >= 1 && quotes[0].amountOut > 0n;
  }, "multi-protocol quote returns sorted quotes");

  console.log("\n── WRONG: must throw ──");
  await expectThrow(() => sdk.quote({ fromToken: ETH, toToken: USDC, fromAmount: 1n, fromChainId: 999, skipMEVCheck: true }), "unsupported chain 999 rejected");
  await expectThrow(() => sdk.quote({ fromToken: ETH, toToken: USDC, fromAmount: 1n, fromChainId: 1, toChainId: 8453, skipMEVCheck: true }), "cross-chain (no adapter) rejected");
  await expectThrow(() => sdk.quote({ fromToken: DEAD, toToken: USDC, fromAmount: 1_000000000000000000n, fromChainId: 1, skipMEVCheck: true }), "invalid/no-liquidity token rejected");
  await expectThrow(() => sdk.quote({ fromToken: ETH, toToken: USDC, fromAmount: 1n, fromChainId: 1, maxSlippageBps: 2001, skipMEVCheck: true }), "slippage 2001 rejected");
  await expectThrow(() => swapUni(USDC, DEAD, 1_000000n), "no-pool pair (USDC→DEAD) rejected at quote");
  await expectThrow(async () => {
    // recipient != signer must be blocked by the execution guard
    const intent = normalizeIntent({ fromToken: ETH, toToken: USDC, fromAmount: 1_000000000000000000n, fromChainId: 1, protocols: ["uniswap-v4"], skipMEVCheck: true, recipient: OTHER as `0x${string}` });
    const quote = await adapter.quote(intent);
    return engine.execute(intent, quote, walletClient as any, publicClient as any);
  }, "recipient != signer blocked");
  await expectThrow(() => swapUni(ETH, USDC, 1_000_000_000000000000000000n), "insufficient balance (1,000,000 ETH) reverts");

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e?.shortMessage || e?.message || e); process.exit(1); });
