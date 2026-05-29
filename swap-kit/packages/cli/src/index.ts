#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { SwapKit } from "@swap-kit/core";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, base, arbitrum } from "viem/chains";
import { parseAmount, displayQuote } from "./utils.js";
import * as dotenv from "dotenv";
import * as p from "@clack/prompts";
import { getChainConfig, getPublicClient } from "@swap-kit/core";

// Load environment variables
dotenv.config();

const program = new Command();
const kit = new SwapKit({
  oneInchApiKey: process.env.ONE_INCH_API_KEY || process.env.ONEINCH_API_KEY || "",
});

// Standard Chain mapping
const CHAINS: Record<string, any> = {
  "1": mainnet,
  "8453": base,
  "42161": arbitrum,
};

program
  .name("swap-kit")
  .description("CLI for Intent-Based DeFi Swaps across Uniswap V4, 1inch, and Paraswap")
  .version("1.0.0");

program
  .command("quote")
  .description("Get the best swap quote across all supported protocols")
  .requiredOption("-f, --from <token>", "Source token address")
  .requiredOption("-t, --to <token>", "Destination token address")
  .requiredOption("-a, --amount <amount>", "Amount to swap (human readable, e.g. 1.5)")
  .option("-c, --chain <id>", "Chain ID (default: 1)", "1")
  .option("-d, --decimals <decimals>", "Source token decimals (default: 18)", "18")
  .option("-s, --slippage <bps>", "Max slippage in basis points (default: 50)", "50")
  .action(async (options) => {
    const spinner = ora("Scanning DEXs and Intents for best route...").start();
    
    try {
      const chainId = parseInt(options.chain, 10);
      const decimals = parseInt(options.decimals, 10);
      const slippage = parseInt(options.slippage, 10);

      if (isNaN(chainId) || isNaN(decimals) || isNaN(slippage)) {
        throw new Error("Invalid numeric arguments provided for chain, decimals, or slippage.");
      }

      const intent = {
        fromChainId: chainId,
        toChainId: chainId, // Add cross-chain support later
        fromToken: options.from,
        toToken: options.to,
        fromAmount: parseAmount(options.amount, decimals),
        maxSlippageBps: slippage,
      };

      const quotes = await kit.quote(intent);
      const quote = quotes[0]; // best quote
      if (!quote) throw new Error("No quotes returned.");
      
      spinner.succeed("Route optimized successfully!");
      
      // Fetch the real destination token decimals to format the output correctly
      let destDecimals = 18;
      try {
        const { getPublicClient, getTokenDecimals } = await import("@swap-kit/core");
        const client = getPublicClient(intent.toChainId);
        destDecimals = await getTokenDecimals(intent.toToken as any, client as any);
      } catch (e) {
        console.warn(chalk.yellow("Warning: Could not fetch destination token decimals, falling back to 18"));
      }

      displayQuote(quote, destDecimals);
    } catch (error: any) {
      spinner.fail(chalk.red("Failed to get quote"));
      console.error(error.message);
    }
  });

program
  .command("simulate")
  .description("Simulate MEV risk and extraction for a specific quote via the Rust Engine")
  .requiredOption("-q, --quote <quoteJson>", "JSON string of the quote to simulate")
  .option("-s, --slippage <bps>", "Max slippage in basis points (default: 50)", "50")
  .action(async (options) => {
    const spinner = ora("Connecting to Rust MEV Simulator...").start();
    try {
      let quote;
      try {
        quote = JSON.parse(options.quote);
      } catch (err) {
        throw new Error("Failed to parse quote JSON. Ensure you pass a valid JSON string.");
      }

      if (!quote || !quote.protocol || !quote.routeData) {
        throw new Error("Invalid quote payload structure.");
      }

      // Determine chain from quote (Uniswap V4 poolKey, 1inch order, or Paraswap network)
      let chainId = 1;
      if (quote.protocol === "uniswap-v4") chainId = quote.routeData.poolKey?.chainId || 1;
      else if (quote.protocol === "1inch-fusion") chainId = quote.routeData.order?.srcChainId || 1;
      else if (quote.protocol === "paraswap") chainId = parseInt(quote.routeData.priceRoute?.network || "1", 10);

      // Try to extract real token addresses and amounts
      const fromToken = quote.routeData.srcToken || quote.routeData.priceRoute?.srcToken || "0x0000000000000000000000000000000000000000";
      const toToken = quote.routeData.dstToken || quote.routeData.priceRoute?.destToken || "0x0000000000000000000000000000000000000000";
      const fromAmount = quote.routeData.fromAmount || quote.routeData.priceRoute?.srcAmount || "0";
      
      const slippage = parseInt(options.slippage, 10);
      if (isNaN(slippage)) throw new Error("Invalid slippage provided.");

      const intent = {
        fromChainId: chainId,
        toChainId: chainId,
        fromToken,
        toToken,
        fromAmount: BigInt(fromAmount),
        maxSlippageBps: slippage,
      };
      const report = await kit.getMEVGuard().simulate(intent as any, quote);
      
      spinner.succeed("Simulation complete!");
      console.log(chalk.bold("\n🛡️  MEV Simulation Report:"));
      console.log(`Risk Level:   ${report.sandwichRisk === "high" ? chalk.red("HIGH") : chalk.green(report.sandwichRisk.toUpperCase())}`);
      console.log(`Extracted:    ${report.estimatedMEVWei > 0n ? chalk.red(report.estimatedMEVWei.toString()) : "0"} Wei`);
      console.log(`Rec. Slippage:${chalk.yellow(report.recommendedSlippageBps)} bps\n`);
    } catch (e: any) {
      spinner.fail("Simulation failed");
      console.error(chalk.red(e.message));
    }
  });

program
  .command("execute")
  .description("Execute a swap using the private key in .env (PRIVATE_KEY)")
  .requiredOption("-q, --quote <quoteJson>", "JSON string of the quote to execute")
  .action(async (options) => {
    try {
      if (!process.env.PRIVATE_KEY) {
        throw new Error("PRIVATE_KEY not found in .env");
      }

      let quote;
      try {
        quote = JSON.parse(options.quote);
      } catch (err) {
        throw new Error("Failed to parse quote JSON. Ensure you pass a valid JSON string.");
      }

      if (!quote || !quote.protocol || !quote.routeData) {
        throw new Error("Invalid quote payload structure.");
      }
      
      // Determine chain ID accurately
      let chainId = 1;
      if (quote.protocol === "uniswap-v4") chainId = quote.routeData.poolKey?.chainId || 1;
      else if (quote.protocol === "1inch-fusion") chainId = quote.routeData.order?.srcChainId || 1;
      else if (quote.protocol === "paraswap") chainId = parseInt(quote.routeData.priceRoute?.network || "1", 10);

      const chain = CHAINS[chainId.toString()];
      if (!chain) {
        throw new Error(`Unsupported chain ID: ${chainId}`);
      }
      
      let account;
      try {
        account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY.replace('0x', '')}`);
      } catch (err) {
        throw new Error("Invalid PRIVATE_KEY format in .env. It must be a valid hex string.");
      }
      
      // Interactive confirmation using @clack/prompts
      p.intro(chalk.bgBlue.black(" SwapKit Execution Engine "));
      
      const proceed = await p.confirm({
        message: `Are you sure you want to execute this ${quote.protocol} swap on ${chain.name} with account ${account.address}?`,
        initialValue: false
      });

      if (p.isCancel(proceed) || !proceed) {
        p.cancel("Transaction cancelled by user.");
        process.exit(0);
      }
      
      // Select the correct RPC based on chain ID safely
      let rpcUrl = process.env[`RPC_${chain.name.toUpperCase()}`];
      if (!rpcUrl) {
          // Fallback to core SDK config
          try {
              const config = getChainConfig(chainId);
              rpcUrl = config.rpcUrl;
          } catch (e) {
              throw new Error(`Could not determine RPC for chain ${chainId}. Set RPC_${chain.name.toUpperCase()} in .env`);
          }
      }

      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpcUrl),
      });

      const spinner = p.spinner();
      spinner.start(`Executing trade via ${quote.protocol}...`);
      
      const result = await kit.execute(quote, walletClient as any);
      spinner.stop(chalk.green(`Execution successful! TxHash: ${result.txHash}`));
      
      p.outro(chalk.bold("Swap complete."));
    } catch (e: any) {
      console.error(chalk.red(`\nError: ${e.message}`));
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch(err => {
    console.error(chalk.red(err.message));
    process.exit(1);
});
