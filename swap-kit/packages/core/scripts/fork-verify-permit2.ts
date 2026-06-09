/**
 * Isolated proof of the Permit2 two-leg approval fix: a USDC→WETH swap via
 * Uniswap V4 (ERC-20 input). Uses the adapter + ExecutionEngine directly so the
 * QuoteEngine's 15s race wrapper can't time out on cold fork eth_calls.
 *
 * Requires the account to already hold USDC on the fork (run fork-verify.ts first).
 *
 *   RPC_ETHEREUM=http://127.0.0.1:8545 npx tsx scripts/fork-verify-permit2.ts
 */
import { createWalletClient, createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { UniswapV4Adapter, ExecutionEngine, normalizeIntent } from "../src/index.js";
import { getTokenBalance } from "../src/utils/token.js";

const ANVIL = "http://127.0.0.1:8545";
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UR = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";

const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({ account, chain: mainnet, transport: http(ANVIL) });
const publicClient = createPublicClient({ chain: mainnet, transport: http(ANVIL) });

async function allowanceERC20(token: string, spender: string) {
  return publicClient.readContract({
    address: token as `0x${string}`,
    abi: [{ type: "function", name: "allowance", stateMutability: "view",
      inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }],
      outputs: [{ type: "uint256" }] }],
    functionName: "allowance", args: [account.address, spender as `0x${string}`],
  }) as Promise<bigint>;
}

async function main() {
  const adapter = new UniswapV4Adapter();
  const engine = new ExecutionEngine([adapter], { flashbotsEnabled: false });

  const usdc = await getTokenBalance(USDC, account.address, publicClient as any);
  const spend = usdc / 2n;
  console.log(`Spending ${formatUnits(spend, 6)} of ${formatUnits(usdc, 6)} USDC → WETH\n`);

  const intent = normalizeIntent({
    fromToken: USDC, toToken: WETH, fromAmount: spend, fromChainId: 1,
    protocols: ["uniswap-v4"], skipMEVCheck: true,
  });

  console.log("Quoting (direct adapter, no race timeout)…");
  const quote = await adapter.quote(intent);
  console.log(`  quote amountOut = ${formatUnits(quote.amountOut, 18)} WETH`);

  const wethBefore = await getTokenBalance(WETH, account.address, publicClient as any);
  const res = await engine.execute(intent, quote, walletClient as any, publicClient as any);
  const wethAfter = await getTokenBalance(WETH, account.address, publicClient as any);

  console.log(`\n  txHash = ${res.txHash}`);
  console.log(`  ERC20→Permit2 allowance now: ${await allowanceERC20(USDC, PERMIT2)}`);
  console.log(`  Permit2→Router allowance (uint160) confirmed via successful pull`);
  console.log(`  WETH: ${formatUnits(wethBefore, 18)} → ${formatUnits(wethAfter, 18)} (Δ ${formatUnits(wethAfter - wethBefore, 18)})`);

  const ok = wethAfter > wethBefore;
  console.log(`\n──── ${ok ? "✅ PASS" : "❌ FAIL"}: Permit2 two-leg approval + ERC20-input v4 swap ────`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e?.shortMessage || e?.message || e); process.exit(1); });
