import { OutsmartDex } from '../venues/types';

/** Where a candidate came from */
export type DiscoverySource =
  | 'pump-recent'
  | 'pump-bonding'
  | 'pump-live'
  | 'dex-boost'
  | 'dex-profile'
  | 'dex-pair'
  | 'stream-new-pool'
  | 'stream-bonding-complete';

/**
 * Normalized meme-coin candidate ready for scoring.
 * Providers map their raw APIs into this shape.
 */
export interface CandidateCoin {
  mint: string;
  symbol: string;
  name: string;
  source: DiscoverySource;
  discoveredAt: number;

  /** Prefer venue for entry when known */
  dex?: OutsmartDex;
  pool?: string;

  marketCapUsd?: number;
  liquidityUsd?: number;
  volumeM5Usd?: number;
  volumeH1Usd?: number;
  volumeH6Usd?: number;
  buysM5?: number;
  sellsM5?: number;
  buysH1?: number;
  sellsH1?: number;
  priceChangeM5Pct?: number;
  priceChangeH1Pct?: number;

  /** Pump bonding progress 0–100 (≈ real SOL / ~85) */
  bondingProgressPct?: number;
  graduated?: boolean;
  ageMinutes?: number;

  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  replyCount?: number;
  isLive?: boolean;
  boostAmount?: number;
  athMarketCapUsd?: number;
  drawdownFromAthPct?: number;

  twitterUrl?: string;
  telegramUrl?: string;
  websiteUrl?: string;
  raw?: unknown;
}

export interface ScoreBreakdown {
  /** 0–100 composite */
  total: number;
  /** Individual factor contributions (already weighted) */
  factors: Record<string, number>;
  /** Hard rejects — empty means eligible */
  rejects: string[];
  /** Why this coin ranked (human-readable) */
  reasons: string[];
}

export interface RankedCoin {
  candidate: CandidateCoin;
  score: ScoreBreakdown;
}

/** Named selection profiles tune which factors matter for "what to buy" */
export type SelectionProfileName =
  | 'balanced'
  | 'graduate'
  | 'momentum'
  | 'social'
  | 'scalp'
  | 'early';

export interface SelectionProfile {
  name: SelectionProfileName;
  description: string;
  /** Minimum composite score (0–100) to buy / surface */
  minScore: number;
  weights: {
    marketCapBand: number;
    liquidity: number;
    volumeVelocity: number;
    buyPressure: number;
    social: number;
    engagement: number;
    bondingProgress: number;
    freshness: number;
    boost: number;
    liveStream: number;
    athHealth: number;
  };
  gates: {
    minMarketCapUsd: number;
    maxMarketCapUsd: number;
    minLiquidityUsd: number;
    maxAgeMinutes: number;
    minAgeMinutes: number;
    requireSocial?: boolean;
    requireNotGraduated?: boolean;
    requireGraduated?: boolean;
    minBondingProgressPct?: number;
    maxBondingProgressPct?: number;
    minBuySellRatioH1?: number;
  };
}

export interface DiscoveryRuntimeConfig {
  enabled: boolean;
  /** explore = rank & log only; trade = emit buyable picks */
  mode: 'explore' | 'trade';
  profile: SelectionProfileName;
  pollIntervalMs: number;
  topN: number;
  enablePump: boolean;
  enableDexScreener: boolean;
  /** Also score inbound stream signals before buying */
  scoreStreamSignals: boolean;
}
