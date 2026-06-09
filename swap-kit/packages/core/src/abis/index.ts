/**
 * Minimal ABI definitions for Uniswap V4 and common ERC-20 interactions.
 * These are the subset of functions needed by swap-kit adapters.
 */

// ─── UniversalRouter ──────────────────────────────────────────────────────────
// https://docs.uniswap.org/contracts/v4/reference/periphery/UniversalRouter

export const UniversalRouterABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "commands", type: "bytes", internalType: "bytes" },
      { name: "inputs", type: "bytes[]", internalType: "bytes[]" },
      { name: "deadline", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "commands", type: "bytes", internalType: "bytes" },
      { name: "inputs", type: "bytes[]", internalType: "bytes[]" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

// ─── V4 Quoter ────────────────────────────────────────────────────────────────
// Matches the DEPLOYED Uniswap V4 `Quoter` (IV4Quoter). Verified on mainnet
// (0x52f0…1203): selector 0xaa9d21cb. The QuoteExactSingleParams struct has NO
// `sqrtPriceLimitX96`, and the function returns two scalars
// `(uint256 amountOut, uint256 gasEstimate)` — NOT arrays. Encoding the older
// (sqrtPriceLimitX96 + array-output) shape reverts on-chain.

export const V4QuoterABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    inputs: [
      {
        name: "params",
        type: "tuple",
        internalType: "struct IV4Quoter.QuoteExactSingleParams",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            internalType: "struct PoolKey",
            components: [
              { name: "currency0", type: "address", internalType: "Currency" },
              { name: "currency1", type: "address", internalType: "Currency" },
              { name: "fee", type: "uint24", internalType: "uint24" },
              { name: "tickSpacing", type: "int24", internalType: "int24" },
              { name: "hooks", type: "address", internalType: "contract IHooks" },
            ],
          },
          { name: "zeroForOne", type: "bool", internalType: "bool" },
          { name: "exactAmount", type: "uint128", internalType: "uint128" },
          { name: "hookData", type: "bytes", internalType: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256", internalType: "uint256" },
      { name: "gasEstimate", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

// ─── Permit2 ──────────────────────────────────────────────────────────────────

export const Permit2ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "token", type: "address", internalType: "address" },
      { name: "spender", type: "address", internalType: "address" },
      { name: "amount", type: "uint160", internalType: "uint160" },
      { name: "expiration", type: "uint48", internalType: "uint48" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address", internalType: "address" },
      { name: "token", type: "address", internalType: "address" },
      { name: "spender", type: "address", internalType: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160", internalType: "uint160" },
      { name: "expiration", type: "uint48", internalType: "uint48" },
      { name: "nonce", type: "uint48", internalType: "uint48" },
    ],
    stateMutability: "view",
  },
] as const;

// ─── ERC-20 ───────────────────────────────────────────────────────────────────

export const ERC20ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address", internalType: "address" },
      { name: "spender", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      { name: "account", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8", internalType: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      { name: "from", type: "address", internalType: "address" },
      { name: "to", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;
