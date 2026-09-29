export type OutsmartDex =
  | 'raydium-amm-v4'
  | 'raydium-cpmm'
  | 'raydium-clmm'
  | 'raydium-launchlab'
  | 'meteora-damm-v1'
  | 'meteora-damm-v2'
  | 'meteora-dlmm'
  | 'meteora-dbc'
  | 'pumpfun'
  | 'pumpfun-amm'
  | 'orca'
  | 'byreal-clmm'
  | 'pancakeswap-clmm'
  | 'fusion-amm'
  | 'futarchy-amm'
  | 'jupiter-ultra'
  | 'dflow';

/** Stream engine DEX labels → Outsmart adapter names */
export const STREAM_DEX_TO_ADAPTER: Record<string, OutsmartDex> = {
  'raydium-amm-v4': 'raydium-amm-v4',
  'raydium-cpmm': 'raydium-cpmm',
  'raydium-clmm': 'raydium-clmm',
  'raydium-launchlab': 'raydium-launchlab',
  'meteora-damm-v1': 'meteora-damm-v1',
  'meteora-damm-v2': 'meteora-damm-v2',
  'meteora-dlmm': 'meteora-dlmm',
  'meteora-dbc': 'meteora-dbc',
  pumpfun: 'pumpfun',
  pumpswap: 'pumpfun-amm',
  'pumpfun-amm': 'pumpfun-amm',
  orca: 'orca',
  'byreal-clmm': 'byreal-clmm',
  'pancakeswap-clmm': 'pancakeswap-clmm',
  'fusion-amm': 'fusion-amm',
  'futarchy-amm': 'futarchy-amm',
};

export interface TradeSignal {
  dex: OutsmartDex;
  pool: string;
  /** Non-quote token mint when known */
  mint?: string;
  tokenA?: string;
  tokenB?: string;
  source: 'new-pool' | 'bonding-complete' | 'manual';
  discoveredAt: number;
  signature?: string;
}

export interface OpenPosition {
  dex: OutsmartDex;
  pool: string;
  mint: string;
  boughtAt: number;
  buySignature?: string;
}
