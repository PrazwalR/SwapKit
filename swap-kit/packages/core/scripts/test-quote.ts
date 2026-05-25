import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { ParaswapAdapter } from "../src/adapters/paraswap.js";
import { OneInchFusionAdapter } from "../src/adapters/one-inch.js";

async function main() {
  console.log("Testing Swap Adapters...\n");

  const fromToken = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // WETH
  const toToken = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC
  const amount = 1000000000000000000n; // 1 WETH

  const intent = {
    fromChainId: 1,
    toChainId: 1,
    fromToken,
    toToken,
    fromAmount: amount,
    minAmountOut: 0n,
    receiver: "0x0000000000000000000000000000000000000001",
    maxSlippageBps: 50,
  } as any;

  // Test Paraswap
  try {
    console.log("--- Testing Paraswap ---");
    const paraswap = new ParaswapAdapter();
    const quote = await paraswap.quote(intent);
    console.log("Paraswap Quote Success!");
    console.log(`Amount Out: ${quote.amountOut.toString()} USDC wei`);
  } catch (e: any) {
    console.error("Paraswap Quote Failed:", e.message);
    if (e.response) {
      console.error(await e.response.text());
    }
  }

  // Test 1inch (requires API Key)
  try {
    console.log("\n--- Testing 1inch Fusion+ ---");
    const apiKey = process.env.ONE_INCH_API_KEY || "TEST_KEY";
    const oneInch = new OneInchFusionAdapter(apiKey);
    const quote = await oneInch.quote(intent);
    console.log("1inch Quote Success!");
    console.log(`Amount Out: ${quote.amountOut.toString()} USDC wei`);
  } catch (e: any) {
    console.error("1inch Quote Failed:", e.message);
  }
}

main().catch(console.error);
