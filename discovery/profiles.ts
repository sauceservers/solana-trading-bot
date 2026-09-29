import { CandidateCoin, SelectionProfile, SelectionProfileName } from './types';

/**
 * Selection profiles answer "which coins should we buy?" — not entry/exit timing.
 * Each profile reweights the same factors toward a different meme-coin edge.
 */
export const SELECTION_PROFILES: Record<SelectionProfileName, SelectionProfile> = {
  balanced: {
    name: 'balanced',
    description: 'Mid-cap memes with liquidity, mild momentum, and at least one social',
    minScore: 55,
    weights: {
      marketCapBand: 18,
      liquidity: 14,
      volumeVelocity: 16,
      buyPressure: 12,
      social: 12,
      engagement: 6,
      bondingProgress: 8,
      freshness: 6,
      boost: 4,
      liveStream: 2,
      athHealth: 2,
    },
    gates: {
      minMarketCapUsd: 8_000,
      maxMarketCapUsd: 400_000,
      minLiquidityUsd: 3_000,
      minAgeMinutes: 1,
      maxAgeMinutes: 60 * 12,
      requireSocial: true,
    },
  },

  graduate: {
    name: 'graduate',
    description: 'Pump.fun coins near graduation (~60–99% bonding) before / at migration',
    minScore: 58,
    weights: {
      marketCapBand: 10,
      liquidity: 8,
      volumeVelocity: 14,
      buyPressure: 12,
      social: 10,
      engagement: 8,
      bondingProgress: 28,
      freshness: 4,
      boost: 2,
      liveStream: 2,
      athHealth: 2,
    },
    gates: {
      minMarketCapUsd: 15_000,
      maxMarketCapUsd: 120_000,
      minLiquidityUsd: 0,
      minAgeMinutes: 0,
      maxAgeMinutes: 60 * 24,
      requireNotGraduated: true,
      minBondingProgressPct: 55,
      maxBondingProgressPct: 99,
    },
  },

  momentum: {
    name: 'momentum',
    description: 'Post-launch / migrated coins with strong buy pressure and rising volume',
    minScore: 60,
    weights: {
      marketCapBand: 12,
      liquidity: 12,
      volumeVelocity: 26,
      buyPressure: 22,
      social: 6,
      engagement: 4,
      bondingProgress: 0,
      freshness: 6,
      boost: 6,
      liveStream: 2,
      athHealth: 4,
    },
    gates: {
      minMarketCapUsd: 20_000,
      maxMarketCapUsd: 1_500_000,
      minLiquidityUsd: 8_000,
      minAgeMinutes: 2,
      maxAgeMinutes: 60 * 48,
      minBuySellRatioH1: 1.05,
    },
  },

  social: {
    name: 'social',
    description: 'Early coins that already have Twitter/TG/site + replies (narrative forming)',
    minScore: 52,
    weights: {
      marketCapBand: 14,
      liquidity: 8,
      volumeVelocity: 10,
      buyPressure: 8,
      social: 28,
      engagement: 18,
      bondingProgress: 6,
      freshness: 4,
      boost: 2,
      liveStream: 2,
      athHealth: 0,
    },
    gates: {
      minMarketCapUsd: 5_000,
      maxMarketCapUsd: 250_000,
      minLiquidityUsd: 1_000,
      minAgeMinutes: 0,
      maxAgeMinutes: 60 * 6,
      requireSocial: true,
    },
  },

  scalp: {
    name: 'scalp',
    description: 'Very fresh hot flow — high m5 volume / boosts, quick in-and-out candidates',
    minScore: 62,
    weights: {
      marketCapBand: 8,
      liquidity: 10,
      volumeVelocity: 30,
      buyPressure: 18,
      social: 4,
      engagement: 4,
      bondingProgress: 4,
      freshness: 12,
      boost: 8,
      liveStream: 2,
      athHealth: 0,
    },
    gates: {
      minMarketCapUsd: 10_000,
      maxMarketCapUsd: 500_000,
      minLiquidityUsd: 4_000,
      minAgeMinutes: 0,
      maxAgeMinutes: 90,
    },
  },

  early: {
    name: 'early',
    description: 'Low mcap bonding coins with socials before crowd arrives (higher risk)',
    minScore: 50,
    weights: {
      marketCapBand: 20,
      liquidity: 6,
      volumeVelocity: 10,
      buyPressure: 10,
      social: 20,
      engagement: 10,
      bondingProgress: 8,
      freshness: 12,
      boost: 2,
      liveStream: 2,
      athHealth: 0,
    },
    gates: {
      minMarketCapUsd: 2_000,
      maxMarketCapUsd: 40_000,
      minLiquidityUsd: 0,
      minAgeMinutes: 0,
      maxAgeMinutes: 60,
      requireSocial: true,
      requireNotGraduated: true,
      maxBondingProgressPct: 50,
    },
  },
};

export function getSelectionProfile(name: string): SelectionProfile {
  const key = (name || 'balanced').toLowerCase() as SelectionProfileName;
  return SELECTION_PROFILES[key] ?? SELECTION_PROFILES.balanced;
}

/** Clamp helper used by scorer */
export function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Soft band score: 1 inside [lo,hi], tapers outside */
export function bandScore(value: number | undefined, lo: number, hi: number, soft = 0.5): number {
  if (value === undefined || value <= 0) return 0;
  if (value >= lo && value <= hi) return 1;
  if (value < lo) {
    const floor = lo * soft;
    if (value <= floor) return 0;
    return clamp01((value - floor) / (lo - floor));
  }
  const ceil = hi * (1 + soft);
  if (value >= ceil) return 0;
  return clamp01(1 - (value - hi) / (ceil - hi));
}

export function buySellRatio(buys?: number, sells?: number): number | undefined {
  if (buys === undefined || sells === undefined) return undefined;
  if (sells <= 0) return buys > 0 ? 3 : 1;
  return buys / sells;
}

export function ageMinutesFromTs(createdMs?: number, now = Date.now()): number | undefined {
  if (!createdMs) return undefined;
  return Math.max(0, (now - createdMs) / 60_000);
}

export function drawdownPct(ath?: number, current?: number): number | undefined {
  if (!ath || !current || ath <= 0) return undefined;
  return Math.max(0, ((ath - current) / ath) * 100);
}

/** Approximate Pump.fun graduation progress from real SOL reserves */
export function bondingProgressFromRealSol(realSolReservesLamports?: number): number | undefined {
  if (realSolReservesLamports === undefined || realSolReservesLamports === null) return undefined;
  const sol = realSolReservesLamports / 1e9;
  // Historical Pump graduation target ~85 SOL raised into the curve
  return clamp01(sol / 85) * 100;
}

export function hasAnySocial(c: CandidateCoin): boolean {
  return Boolean(c.hasTwitter || c.hasTelegram || c.hasWebsite);
}
