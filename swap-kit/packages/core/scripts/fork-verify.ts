/**
 * Fork verification — proves the critical fixes work end-to-end against a
 * mainnet fork (anvil), with ZERO real funds at risk.
 *
 * Run:
 *   anvil --fork-url $RPC_ETHEREUM --port 8545 --silent &
 *   RPC_ETHEREUM=http://127.0.0.1:8545 npx tsx scripts/fork-verify.ts
 *
 * What it checks:
 *   A. Uniswap V4 quote now returns a real on-chain amount (the Quoter ABI fix).
 *   B. An ETH→USDC swap via Uniswap V4 actually executes; USDC balance rises.
 *   C. A USDC→WETH swap via Uniswap V4 executes — exercises BOTH Permit2 approval
 *      legs (ERC20→Permit2 and Permit2→UniversalRouter).
 */
import { createWalletClient, createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { createSwapKit } from "../src/index.js";
import { getTokenBalance } from "../src/utils/token.js";

const ANVIL = "http://127.0.0.1:8545";
// anvil default account #0 — well-known dev key, prefunded with 10000 ETH on the fork.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({ account, chain: mainnet, transport: http(ANVIL) });
const publicClient = createPublicClient({ chain: mainnet, transport: http(ANVIL) });

// flashbots OFF + skip MEV so nothing reroutes off the fork to a real relay.
const sdk = createSwapKit({ oneInchApiKey: "", flashbotsEnabled: false });

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? (pass++, console.log("✅ " + m)) : (fail++, console.log("❌ " + m)); };

async function main() {
  console.log("\n=== A. Uniswap V4 quote (ABI fix) ===");
  const quotes = await sdk.quote({
    fromToken: ETH, toToken: USDC, fromAmount: 50000000000000000n /* 0.05 ETH */,
    fromChainId: 1, skipMEVCheck: true,
  });
  for (const q of quotes) {
    console.log(`  ${q.protocol.padEnd(13)} amountOut=${formatUnits(q.amountOut, 6)} USDC  gas=${q.gasCostWei}`);
  }
  const uni = quotes.find(q => q.protocol === "uniswap-v4");
  ok(!!uni && uni.amountOut > 0n, "Uniswap V4 returns a real quote (was always throwing before)");

  console.log("\n=== B. ETH→USDC swap via Uniswap V4 (native input, real tx) ===");
  const usdcBefore = await getTokenBalance(USDC, account.address, publicClient as any);
  const resB = await sdk.swap(
    { fromToken: ETH, toToken: USDC, fromAmount: 50000000000000000n, fromChainId: 1,
      protocols: ["uniswap-v4"], skipMEVCheck: true },
    walletClient as any, publicClient as any,
  );
  const usdcAfter = await getTokenBalance(USDC, account.address, publicClient as any);
  console.log(`  txHash=${resB.txHash}`);
  console.log(`  USDC: ${formatUnits(usdcBefore, 6)} → ${formatUnits(usdcAfter, 6)} (Δ ${formatUnits(usdcAfter - usdcBefore, 6)})`);
  console.log(`  gasPaidWei=${resB.gasPaidWei}  actualAmountOut=${formatUnits(resB.actualAmountOut, 6)}`);
  ok(usdcAfter > usdcBefore, "ETH→USDC executed and USDC balance increased");

  console.log("\n=== C. USDC→WETH swap via Uniswap V4 (ERC20 input → Permit2 two-leg) ===");
  const spend = usdcAfter / 2n; // spend half the USDC we just got
  const wethBefore = await getTokenBalance(WETH, account.address, publicClient as any);
  const resC = await sdk.swap(
    { fromToken: USDC, toToken: WETH, fromAmount: spend, fromChainId: 1,
      protocols: ["uniswap-v4"], skipMEVCheck: true },
    walletClient as any, publicClient as any,
  );
  const wethAfter = await getTokenBalance(WETH, account.address, publicClient as any);
  console.log(`  txHash=${resC.txHash}`);
  console.log(`  WETH: ${formatUnits(wethBefore, 18)} → ${formatUnits(wethAfter, 18)} (Δ ${formatUnits(wethAfter - wethBefore, 18)})`);
  ok(wethAfter > wethBefore, "USDC→WETH executed (both Permit2 approvals worked) and WETH increased");

  console.log(`\n──── RESULT: ${pass} passed, ${fail} failed ────`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.shortMessage || e?.message || e); process.exit(1); });
