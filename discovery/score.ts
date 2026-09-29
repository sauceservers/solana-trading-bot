import {
  CandidateCoin,
  RankedCoin,
  ScoreBreakdown,
  SelectionProfile,
} from './types';
import {
  bandScore,
  buySellRatio,
  clamp01,
  hasAnySocial,
} from './profiles';

/**
 * Scores a candidate for "should we buy this coin?" under a selection profile.
 * Hard gates reject; soft factors accumulate into a 0–100 composite.
 */
export function scoreCandidate(candidate: CandidateCoin, profile: SelectionProfile): RankedCoin {
  const rejects: string[] = [];
  const reasons: string[] = [];
  const factors: Record<string, number> = {};
  const w = profile.weights;
  const g = profile.gates;

  const mcap = candidate.marketCapUsd;
  const liq = candidate.liquidityUsd ?? inferLiquidity(candidate);
  const age = candidate.ageMinutes;
  const progress = candidate.bondingProgressPct;
  const ratio = buySellRatio(candidate.buysH1 ?? candidate.buysM5, candidate.sellsH1 ?? candidate.sellsM5);

  // ---- Hard gates (what NOT to buy) ----
  if (mcap !== undefined) {
    if (mcap < g.minMarketCapUsd) rejects.push(`mcap ${fmt(mcap)} < min ${fmt(g.minMarketCapUsd)}`);
    if (mcap > g.maxMarketCapUsd) rejects.push(`mcap ${fmt(mcap)} > max ${fmt(g.maxMarketCapUsd)}`);
  } else {
    rejects.push('missing market cap');
  }

  if (g.minLiquidityUsd > 0) {
    if (liq === undefined) rejects.push('missing liquidity');
    else if (liq < g.minLiquidityUsd) rejects.push(`liquidity ${fmt(liq)} < min ${fmt(g.minLiquidityUsd)}`);
  }

  if (age !== undefined) {
    if (age < g.minAgeMinutes) rejects.push(`age ${age.toFixed(1)}m < min ${g.minAgeMinutes}m`);
    if (age > g.maxAgeMinutes) rejects.push(`age ${age.toFixed(1)}m > max ${g.maxAgeMinutes}m`);
  }

  if (g.requireSocial && !hasAnySocial(candidate)) {
    rejects.push('no socials');
  }
  if (g.requireNotGraduated && candidate.graduated === true) {
    rejects.push('already graduated');
  }
  if (g.requireGraduated && candidate.graduated !== true) {
    rejects.push('not graduated');
  }
  if (g.minBondingProgressPct !== undefined) {
    if (progress === undefined) rejects.push('missing bonding progress');
    else if (progress < g.minBondingProgressPct) {
      rejects.push(`bonding ${progress.toFixed(0)}% < min ${g.minBondingProgressPct}%`);
    }
  }
  if (g.maxBondingProgressPct !== undefined && progress !== undefined) {
    if (progress > g.maxBondingProgressPct) {
      rejects.push(`bonding ${progress.toFixed(0)}% > max ${g.maxBondingProgressPct}%`);
    }
  }
  if (g.minBuySellRatioH1 !== undefined && ratio !== undefined && ratio < g.minBuySellRatioH1) {
    rejects.push(`buy/sell ${ratio.toFixed(2)} < ${g.minBuySellRatioH1}`);
  }

  // ---- Soft factors (what TO buy) ----
  // Market-cap sweet spot inside the gate band
  const mcapFactor = bandScore(mcap, g.minMarketCapUsd * 1.2, g.maxMarketCapUsd * 0.7, 0.35);
  factors.marketCapBand = mcapFactor * w.marketCapBand;
  if (mcapFactor > 0.7 && mcap !== undefined) reasons.push(`mcap $${fmt(mcap)} in band`);

  // Liquidity — more is better up to a point (deep pools harder to move)
  const liqFactor = bandScore(liq, Math.max(g.minLiquidityUsd, 2_000), 80_000, 0.4);
  factors.liquidity = liqFactor * w.liquidity;
  if (liqFactor > 0.6 && liq !== undefined) reasons.push(`liq $${fmt(liq)}`);

  // Volume velocity: prefer strong short-horizon flow vs mcap
  const vol = candidate.volumeM5Usd ?? (candidate.volumeH1Usd !== undefined ? candidate.volumeH1Usd / 12 : undefined);
  let volFactor = 0;
  if (vol !== undefined && mcap !== undefined && mcap > 0) {
    const turnover = vol / mcap; // m5 volume / mcap
    volFactor = clamp01(turnover / 0.15); // 15% of mcap in 5m is maxed
  } else if (candidate.volumeH1Usd !== undefined && mcap !== undefined && mcap > 0) {
    volFactor = clamp01(candidate.volumeH1Usd / mcap / 0.5);
  }
  factors.volumeVelocity = volFactor * w.volumeVelocity;
  if (volFactor > 0.5) reasons.push('hot volume');

  // Buy pressure
  let pressureFactor = 0.5;
  if (ratio !== undefined) {
    // 0.5 → 0, 1 → 0.5, 1.5+ → 1
    pressureFactor = clamp01((ratio - 0.5) / 1.0);
  }
  if ((candidate.priceChangeM5Pct ?? 0) > 5) pressureFactor = clamp01(pressureFactor + 0.15);
  if ((candidate.priceChangeH1Pct ?? 0) < -40) pressureFactor = clamp01(pressureFactor - 0.35);
  factors.buyPressure = pressureFactor * w.buyPressure;
  if (ratio !== undefined && ratio >= 1.2) reasons.push(`buys>sells (${ratio.toFixed(2)}x)`);

  // Socials
  let socialFactor = 0;
  if (candidate.hasTwitter) socialFactor += 0.4;
  if (candidate.hasTelegram) socialFactor += 0.35;
  if (candidate.hasWebsite) socialFactor += 0.25;
  factors.social = clamp01(socialFactor) * w.social;
  if (socialFactor >= 0.4) reasons.push('has socials');

  // Engagement (replies)
  const replies = candidate.replyCount ?? 0;
  const engageFactor = clamp01(Math.log10(replies + 1) / 3); // ~1000 replies → 1
  factors.engagement = engageFactor * w.engagement;
  if (replies >= 20) reasons.push(`${replies} replies`);

  // Bonding progress — profile-dependent sweet spots handled partly by gates;
  // soft score peaks near mid-high progress for graduate, lower for early.
  let bondFactor = 0;
  if (progress !== undefined) {
    if (profile.name === 'graduate') {
      bondFactor = bandScore(progress, 60, 95, 0.3);
    } else if (profile.name === 'early') {
      bondFactor = bandScore(progress, 5, 40, 0.4);
    } else {
      bondFactor = bandScore(progress, 20, 85, 0.5);
    }
  }
  factors.bondingProgress = bondFactor * w.bondingProgress;
  if (bondFactor > 0.6 && progress !== undefined) reasons.push(`bonding ${progress.toFixed(0)}%`);

  // Freshness — prefer young but not zero-second rugs for most profiles
  let freshFactor = 0.5;
  if (age !== undefined) {
    if (profile.name === 'scalp' || profile.name === 'early') {
      freshFactor = clamp01(1 - age / Math.max(g.maxAgeMinutes, 1));
    } else {
      // Peak around 10–120 minutes
      freshFactor = bandScore(age, 5, 180, 0.6);
    }
  }
  factors.freshness = freshFactor * w.freshness;

  // DexScreener boosts
  const boost = candidate.boostAmount ?? 0;
  const boostFactor = clamp01(Math.log10(boost + 1) / 3);
  factors.boost = boostFactor * w.boost;
  if (boost >= 10) reasons.push(`boost ×${boost}`);

  // Live stream
  factors.liveStream = (candidate.isLive ? 1 : 0) * w.liveStream;
  if (candidate.isLive) reasons.push('live stream');

  // ATH health — avoid bags already down >70% from ATH
  let athFactor = 0.7;
  if (candidate.drawdownFromAthPct !== undefined) {
    athFactor = clamp01(1 - candidate.drawdownFromAthPct / 80);
    if (candidate.drawdownFromAthPct > 70) {
      rejects.push(`drawdown ${candidate.drawdownFromAthPct.toFixed(0)}% from ATH`);
    }
  }
  factors.athHealth = athFactor * w.athHealth;

  const weightSum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const raw = Object.values(factors).reduce((a, b) => a + b, 0);
  const total = rejects.length ? 0 : Math.round((raw / weightSum) * 1000) / 10;

  const score: ScoreBreakdown = { total, factors, rejects, reasons };
  return { candidate, score };
}

export function rankCandidates(
  candidates: CandidateCoin[],
  profile: SelectionProfile,
  topN = 20,
): RankedCoin[] {
  const seen = new Set<string>();
  const ranked: RankedCoin[] = [];

  for (const c of candidates) {
    if (!c.mint || seen.has(c.mint)) continue;
    seen.add(c.mint);
    ranked.push(scoreCandidate(c, profile));
  }

  return ranked
    .filter((r) => r.score.rejects.length === 0)
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, topN);
}

function inferLiquidity(c: CandidateCoin): number | undefined {
  // Bonding curves: real SOL ≈ half of effective liquidity proxy
  if (c.bondingProgressPct !== undefined && c.marketCapUsd !== undefined) {
    return c.marketCapUsd * 0.15;
  }
  return undefined;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}
