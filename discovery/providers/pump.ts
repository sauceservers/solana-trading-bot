import axios from 'axios';
import { logger } from '../../helpers';
import { CandidateCoin } from '../types';
import {
  ageMinutesFromTs,
  bondingProgressFromRealSol,
  drawdownPct,
} from '../profiles';

const PUMP_API = 'https://frontend-api-v3.pump.fun';

interface PumpCoin {
  mint: string;
  name?: string;
  symbol?: string;
  description?: string;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
  creator?: string;
  created_timestamp?: number;
  complete?: boolean;
  virtual_sol_reserves?: number;
  real_sol_reserves?: number;
  reply_count?: number;
  is_currently_live?: boolean;
  usd_market_cap?: number;
  market_cap?: number;
  ath_market_cap?: number;
  pump_swap_pool?: string | null;
  pool_address?: string | null;
  bonding_curve?: string;
  nsfw?: boolean;
  is_banned?: boolean;
}

function mapPump(coin: PumpCoin, source: CandidateCoin['source']): CandidateCoin | null {
  if (!coin?.mint || coin.is_banned || coin.nsfw) return null;

  const mcap = coin.usd_market_cap ?? coin.market_cap;
  const progress = coin.complete ? 100 : bondingProgressFromRealSol(coin.real_sol_reserves);
  const ath = coin.ath_market_cap;
  const pool = coin.pump_swap_pool || coin.pool_address || coin.bonding_curve;

  return {
    mint: coin.mint,
    symbol: coin.symbol || '???',
    name: coin.name || coin.symbol || 'unknown',
    source,
    discoveredAt: Date.now(),
    dex: coin.complete ? 'pumpfun-amm' : 'pumpfun',
    pool: pool || undefined,
    marketCapUsd: mcap,
    bondingProgressPct: progress,
    graduated: Boolean(coin.complete),
    ageMinutes: ageMinutesFromTs(coin.created_timestamp),
    hasTwitter: Boolean(coin.twitter),
    hasTelegram: Boolean(coin.telegram),
    hasWebsite: Boolean(coin.website),
    twitterUrl: coin.twitter || undefined,
    telegramUrl: coin.telegram || undefined,
    websiteUrl: coin.website || undefined,
    replyCount: coin.reply_count ?? 0,
    isLive: Boolean(coin.is_currently_live),
    athMarketCapUsd: ath,
    drawdownFromAthPct: drawdownPct(ath, mcap),
    raw: coin,
  };
}

async function fetchPumpList(path: string, params: Record<string, string | number | boolean>): Promise<PumpCoin[]> {
  try {
    const { data } = await axios.get(`${PUMP_API}${path}`, {
      params,
      timeout: 12_000,
      headers: { Accept: 'application/json' },
    });
    return Array.isArray(data) ? data : [];
  } catch (error) {
    logger.debug({ error, path, params }, 'Pump.fun fetch failed');
    return [];
  }
}

/** Recently traded incomplete bonding coins */
export async function fetchPumpBonding(limit = 50): Promise<CandidateCoin[]> {
  const rows = await fetchPumpList('/coins', {
    offset: 0,
    limit,
    sort: 'last_trade_timestamp',
    order: 'DESC',
    includeNsfw: false,
    complete: false,
  });
  return rows.map((c) => mapPump(c, 'pump-bonding')).filter(Boolean) as CandidateCoin[];
}

/** Recently traded (includes graduated) */
export async function fetchPumpRecent(limit = 40): Promise<CandidateCoin[]> {
  const rows = await fetchPumpList('/coins', {
    offset: 0,
    limit,
    sort: 'last_trade_timestamp',
    order: 'DESC',
    includeNsfw: false,
  });
  return rows.map((c) => mapPump(c, 'pump-recent')).filter(Boolean) as CandidateCoin[];
}

/** Currently live-streamed coins (often narrative-driven) */
export async function fetchPumpLive(limit = 30): Promise<CandidateCoin[]> {
  const rows = await fetchPumpList('/coins/currently-live', {
    offset: 0,
    limit,
    includeNsfw: false,
  });
  return rows.map((c) => mapPump(c, 'pump-live')).filter(Boolean) as CandidateCoin[];
}

export async function fetchAllPumpCandidates(): Promise<CandidateCoin[]> {
  const [bonding, recent, live] = await Promise.all([
    fetchPumpBonding(),
    fetchPumpRecent(),
    fetchPumpLive(),
  ]);
  return [...bonding, ...recent, ...live];
}
