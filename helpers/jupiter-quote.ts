import { logger } from './logger';

const WSOL = 'So11111111111111111111111111111111111111112';
// lite-api is reachable in more environments than quote-api.jup.ag
const QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';

export interface JupiterQuote {
  inAmount: number;
  outAmount: number;
  /** Human units assuming 9 decimals for SOL side when applicable */
  outAmountUi: number;
  priceImpactPct?: number;
  raw: unknown;
}

/**
 * Best-effort Jupiter quote for paper marks. New pools often have no route yet.
 */
export async function jupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint | number;
  slippageBps: number;
}): Promise<JupiterQuote | null> {
  const amount = typeof params.amountRaw === 'bigint' ? params.amountRaw.toString() : String(params.amountRaw);
  const url =
    `${QUOTE_URL}?inputMint=${params.inputMint}&outputMint=${params.outputMint}` +
    `&amount=${amount}&slippageBps=${params.slippageBps}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      inAmount?: string;
      outAmount?: string;
      priceImpactPct?: string;
      error?: string;
    };
    if (!data.outAmount || data.error) {
      return null;
    }
    const outAmount = Number(data.outAmount);
    const inAmount = Number(data.inAmount || amount);
    // Prefer UI relative to SOL (9 decimals) when SOL is one side
    const outIsSol = params.outputMint === WSOL;
    const outAmountUi = outIsSol ? outAmount / 1e9 : outAmount;
    return {
      inAmount,
      outAmount,
      outAmountUi,
      priceImpactPct: data.priceImpactPct ? Number(data.priceImpactPct) : undefined,
      raw: data,
    };
  } catch (error) {
    logger.debug({ error }, 'Jupiter quote failed');
    return null;
  }
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.max(1, Math.round(sol * 1e9)));
}

export { WSOL };
