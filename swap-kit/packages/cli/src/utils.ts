import chalk from "chalk";
import { formatUnits, parseUnits } from "viem";

export function formatAmount(amount: bigint, decimals: number = 18): string {
  const formatted = formatUnits(amount, decimals);
  // Avoid precision loss from Number conversion
  const [whole, fraction] = formatted.split(".");
  if (!fraction) return whole;
  return `${whole}.${fraction.slice(0, 6)}`;
}

export function parseAmount(amountStr: string, decimals: number = 18): bigint {
  return parseUnits(amountStr, decimals);
}

export function displayQuote(quote: any, decimals: number = 18) {
  const protocolColors: Record<string, any> = {
    "uniswap-v4": chalk.magenta,
    "1inch-fusion": chalk.blueBright,
    "paraswap": chalk.cyan,
  };

  const color = protocolColors[quote.protocol] || chalk.white;
  
  console.log(chalk.bold("\n🏆 Best Quote Found:"));
  console.log(`Protocol:      ${color.bold(quote.protocol)}`);
  console.log(`Amount Out:    ${chalk.green.bold(formatAmount(quote.amountOut, decimals))}`);
  if (quote.mevExposure > 0n) {
    console.log(`MEV Exposure:  ${chalk.red(formatAmount(quote.mevExposure, 18))} (Native)`);
  } else {
    console.log(`MEV Exposure:  ${chalk.green("Protected 🛡️")}`);
  }
  
  if (quote.routeData?.type === "uniswap-v4") {
    console.log(`Pool Fee Tier: ${chalk.gray(quote.routeData.poolKey.fee)} pips`);
  }
  
  console.log("");
}
