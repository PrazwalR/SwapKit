#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { SwapKit, SwapIntentSchema } from "@swap-kit/core";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, base, arbitrum } from "viem/chains";
import { parseAmount, displayQuote } from "./utils.js";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

const program = new Command();
const kit = new SwapKit({
  oneInchApiKey: process.env.ONE_INCH_API_KEY || "YOUR_1INCH_KEY",
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
  .action(async (options) => {
    const spinner = ora("Scanning DEXs and Intents for best route...").start();
    
    try {
      const intent = {
        fromChainId: parseInt(options.chain),
        toChainId: parseInt(options.chain), // Add cross-chain support later
        fromToken: options.from,
        toToken: options.to,
        fromAmount: parseAmount(options.amount, parseInt(options.decimals)),
        maxSlippageBps: 50,
      };

      const quotes = await kit.quote(intent);
      const quote = quotes[0]; // best quote
      spinner.succeed("Route optimized successfully!");
      
      displayQuote(quote);
    } catch (error: any) {
      spinner.fail(chalk.red("Failed to get quote"));
      console.error(error.message);
    }
  });

program
  .command("simulate")
  .description("Simulate MEV risk and extraction for a specific quote via the Rust Engine")
  .requiredOption("-q, --quote <quoteJson>", "JSON string of the quote to simulate")
  .action(async (options) => {
    const spinner = ora("Connecting to Rust MEV Simulator...").start();
    try {
      // In a real CLI, we'd cache quotes locally by ID. For now, pass JSON.
      const quote = JSON.parse(options.quote);
      // Create a dummy intent for simulation if not provided
      const intent = {
        fromChainId: quote.routeData?.poolKey?.chainId || 1,
        toChainId: quote.routeData?.poolKey?.chainId || 1,
        fromToken: "0x0000000000000000000000000000000000000000",
        toToken: "0x0000000000000000000000000000000000000000",
        fromAmount: 0n,
        maxSlippageBps: 50,
      };
      const report = await kit.getMEVGuard().simulate(intent as any, quote);
      
      spinner.succeed("Simulation complete!");
      console.log(chalk.bold("\n🛡️  MEV Simulation Report:"));
      console.log(`Risk Level:   ${report.sandwichRisk === "high" ? chalk.red("HIGH") : chalk.green(report.sandwichRisk.toUpperCase())}`);
      console.log(`Extracted:    ${report.estimatedMEVWei > 0n ? chalk.red(report.estimatedMEVWei.toString()) : "0"} Wei`);
      console.log(`Rec. Slippage:${chalk.yellow(report.recommendedSlippageBps)} bps\n`);
    } catch (e: any) {
      spinner.fail("Simulation failed");
      console.error(e.message);
    }
  });

program
  .command("execute")
  .description("Execute a swap using the private key in .env (PRIVATE_KEY)")
  .requiredOption("-q, --quote <quoteJson>", "JSON string of the quote to execute")
  .action(async (options) => {
    if (!process.env.PRIVATE_KEY) {
      console.error(chalk.red("Error: PRIVATE_KEY not found in .env"));
      process.exit(1);
    }

    const quote = JSON.parse(options.quote);
    const chain = CHAINS[quote.routeData.poolKey?.chainId || "1"] || mainnet;
    
    const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY.replace('0x', '')}`);
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(process.env.RPC_ETHEREUM),
    });

    const spinner = ora(`Executing trade via ${quote.protocol}...`).start();
    try {
      const result = await kit.execute(quote, walletClient as any);
      spinner.succeed(chalk.green(`Execution successful! TxHash: ${result.txHash}`));
    } catch (e: any) {
      spinner.fail("Execution failed");
      console.error(e.message);
    }
  });

program.parse();
