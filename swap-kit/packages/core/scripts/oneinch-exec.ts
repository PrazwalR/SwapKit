import { createWalletClient, createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { OneInchFusionAdapter, ExecutionEngine, normalizeIntent } from "../src/index.js";
import { getTokenBalance } from "../src/utils/token.js";

const ANVIL = "http://127.0.0.1:8545";
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({ account, chain: mainnet, transport: http(ANVIL) });
const publicClient = createPublicClient({ chain: mainnet, transport: http(ANVIL) });
const key = process.env["1INCH_API_KEY"] || "";

async function main() {
  const adapter = new OneInchFusionAdapter(key);
  const engine = new ExecutionEngine([adapter], { flashbotsEnabled: false });
  const intent = normalizeIntent({ fromToken: ETH, toToken: USDC, fromAmount: 500000000000000000n, fromChainId: 1, protocols: ["1inch-fusion"], skipMEVCheck: true });
  const quote = await adapter.quote(intent);
  console.log(`1inch quote: ${formatUnits(quote.amountOut, 6)} USDC for 0.5 ETH`);
  const before = await getTokenBalance(USDC, account.address, publicClient as any);
  const res = await engine.execute(intent, quote, walletClient as any, publicClient as any);
  const after = await getTokenBalance(USDC, account.address, publicClient as any);
  console.log(`tx=${res.txHash}  USDC Δ=${formatUnits(after - before, 6)}`);
  console.log(after > before ? "✅ 1inch ETH→USDC executed on fork" : "❌ no USDC received");
  process.exit(after > before ? 0 : 1);
}
main().catch((e) => { console.error("1inch exec note:", e?.shortMessage || e?.message || e); process.exit(2); });
