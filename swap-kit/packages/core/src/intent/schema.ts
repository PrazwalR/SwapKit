import { z } from "zod";

/**
 * Zod schema for runtime validation of SwapIntent.
 * Useful for API endpoints and user input validation.
 */
export const SwapIntentSchema = z.object({
  fromToken:      z.string(),
  toToken:        z.string(),
  fromAmount:     z.bigint().positive(),
  fromChainId:    z.number().int().positive(),
  toChainId:      z.number().int().positive().optional(),
  maxSlippageBps: z.number().int().min(1).max(2000).optional(),
  deadline:       z.number().int().positive().optional(),
  protocols:      z.array(z.enum(["uniswap-v4", "1inch-fusion", "paraswap"])).optional(),
  skipMEVCheck:   z.boolean().optional(),
  recipient:      z.string().optional(),
});

export type ValidatedSwapIntent = z.infer<typeof SwapIntentSchema>;
