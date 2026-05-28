# @swap-kit/core

> Intent-Based DeFi SDK — unified swap routing across Uniswap V4, 1inch Fusion+, and Paraswap with MEV protection.

## Install

```bash
npm install @swap-kit/core
```

## Quick Start

```typescript
import { createSwapKit } from "@swap-kit/core";

const sdk = createSwapKit({
  oneInchApiKey: process.env.ONEINCH_KEY!,
});

// Get the best quote across Uniswap V4, 1inch, and Paraswap
const quotes = await sdk.quote({
  fromToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // ETH
  toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",   // USDC
  fromAmount: 1000000000000000000n,
  fromChainId: 1,
});

console.log(quotes[0].protocol);  // Best route
console.log(quotes[0].amountOut); // Best price
```

## Supported Chains

| Chain | ID | Uniswap V4 | 1inch | Paraswap |
|---|---|---|---|---|
| Ethereum | 1 | ✅ | ✅ | ✅ |
| Base | 8453 | ✅ | ✅ | ✅ |
| Arbitrum | 42161 | ✅ | ✅ | ✅ |

## Full Documentation

See the [main README](https://github.com/prazwal/swap-kit#readme) for detailed usage, architecture, and API reference.

## License

MIT
