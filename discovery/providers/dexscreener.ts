import axios from 'axios';
import { logger } from '../../helpers';
import { CandidateCoin } from '../types';

const DEX = 'https://api.dexscreener.com';

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  url?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
  };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  boosts?: { active?: number };
  info?: {
    websites?: { url?: string }[];
    socials?: { url?: string; type?: string }[];
  };
}

interface DexBoostOrProfile {
  chainId?: string;
  tokenAddress?: string;
  url?: string;
  description?: string;
  totalAmount?: number;
  amount?: number;
  links?: { type?: string; url?: string }[];
}

function mapPair(pair: DexPair, source: CandidateCoin['source'], boostAmount?: number): CandidateCoin | null {
  if (pair.chainId !== 'solana' || !pair.baseToken?.address) return null;

  const socials = pair.info?.socials ?? [];
  const websites = pair.info?.websites ?? [];
  const hasTwitter = socials.some((s) => s.type === 'twitter' || /x\.com|twitter/i.test(s.url || ''));
  const hasTelegram = socials.some((s) => s.type === 'telegram' || /t\.me/i.test(s.url || ''));
  const ageMinutes =
    pair.pairCreatedAt !== undefined ? Math.max(0, (Date.now() - pair.pairCreatedAt) / 60_000) : undefined;

  const dex = mapDexId(pair.dexId);

  return {
    mint: pair.baseToken.address,
    symbol: pair.baseToken.symbol || '???',
    name: pair.baseToken.name || pair.baseToken.symbol || 'unknown',
    source,
    discoveredAt: Date.now(),
    dex,
    pool: pair.pairAddress,
    marketCapUsd: pair.marketCap ?? pair.fdv,
    liquidityUsd: pair.liquidity?.usd,
    volumeM5Usd: pair.volume?.m5,
    volumeH1Usd: pair.volume?.h1,
    volumeH6Usd: pair.volume?.h6,
    buysM5: pair.txns?.m5?.buys,
    sellsM5: pair.txns?.m5?.sells,
    buysH1: pair.txns?.h1?.buys,
    sellsH1: pair.txns?.h1?.sells,
    priceChangeM5Pct: pair.priceChange?.m5,
    priceChangeH1Pct: pair.priceChange?.h1,
    graduated: true,
    ageMinutes,
    hasTwitter,
    hasTelegram,
    hasWebsite: websites.length > 0,
    websiteUrl: websites[0]?.url,
    twitterUrl: socials.find((s) => s.type === 'twitter')?.url,
    telegramUrl: socials.find((s) => s.type === 'telegram')?.url,
    boostAmount: boostAmount ?? pair.boosts?.active,
    raw: pair,
  };
}

function mapDexId(dexId?: string): CandidateCoin['dex'] {
  switch ((dexId || '').toLowerCase()) {
    case 'pumpswap':
    case 'pumpfun-amm':
      return 'pumpfun-amm';
    case 'raydium':
      return 'raydium-amm-v4';
    case 'raydium-cpmm':
      return 'raydium-cpmm';
    case 'raydium-clmm':
      return 'raydium-clmm';
    case 'meteora':
      return 'meteora-damm-v1';
    case 'orca':
      return 'orca';
    default:
      return 'jupiter-ultra';
  }
}

async function enrichMints(mints: string[]): Promise<Map<string, DexPair>> {
  const map = new Map<string, DexPair>();
  // DexScreener allows comma-separated token addresses (batch)
  const chunkSize = 30;
  for (let i = 0; i < mints.length; i += chunkSize) {
    const chunk = mints.slice(i, i + chunkSize);
    try {
      const { data } = await axios.get(`${DEX}/latest/dex/tokens/${chunk.join(',')}`, {
        timeout: 12_000,
      });
      const pairs: DexPair[] = data?.pairs || [];
      for (const p of pairs) {
        if (p.chainId !== 'solana' || !p.baseToken?.address) continue;
        const existing = map.get(p.baseToken.address);
        const liq = p.liquidity?.usd ?? 0;
        if (!existing || (existing.liquidity?.usd ?? 0) < liq) {
          map.set(p.baseToken.address, p);
        }
      }
    } catch (error) {
      logger.debug({ error, chunk: chunk.length }, 'DexScreener token enrich failed');
    }
  }
  return map;
}

function linksToSocialFlags(links?: { type?: string; url?: string }[]) {
  const list = links || [];
  return {
    hasTwitter: list.some((l) => l.type === 'twitter' || /x\.com|twitter/i.test(l.url || '')),
    hasTelegram: list.some((l) => l.type === 'telegram' || /t\.me/i.test(l.url || '')),
    hasWebsite: list.some((l) => !l.type || l.type === 'website'),
    twitterUrl: list.find((l) => l.type === 'twitter')?.url,
    telegramUrl: list.find((l) => l.type === 'telegram')?.url,
    websiteUrl: list.find((l) => !l.type || l.type === 'website')?.url,
  };
}

export async function fetchDexBoosts(): Promise<CandidateCoin[]> {
  try {
    const [top, latest] = await Promise.all([
      axios.get(`${DEX}/token-boosts/top/v1`, { timeout: 12_000 }),
      axios.get(`${DEX}/token-boosts/latest/v1`, { timeout: 12_000 }),
    ]);
    const rows: DexBoostOrProfile[] = [...(top.data || []), ...(latest.data || [])].filter(
      (r: DexBoostOrProfile) => r.chainId === 'solana' && r.tokenAddress,
    );

    const mints = [...new Set(rows.map((r) => r.tokenAddress!))];
    const pairs = await enrichMints(mints);
    const out: CandidateCoin[] = [];

    for (const row of rows) {
      const mint = row.tokenAddress!;
      const pair = pairs.get(mint);
      const boost = row.totalAmount ?? row.amount ?? 0;
      if (pair) {
        const mapped = mapPair(pair, 'dex-boost', boost);
        if (mapped) out.push(mapped);
        continue;
      }
      const socials = linksToSocialFlags(row.links);
      out.push({
        mint,
        symbol: mint.slice(0, 6),
        name: row.description?.slice(0, 40) || mint.slice(0, 8),
        source: 'dex-boost',
        discoveredAt: Date.now(),
        boostAmount: boost,
        ...socials,
        raw: row,
      });
    }
    return out;
  } catch (error) {
    logger.debug({ error }, 'DexScreener boosts fetch failed');
    return [];
  }
}

export async function fetchDexProfiles(): Promise<CandidateCoin[]> {
  try {
    const { data } = await axios.get(`${DEX}/token-profiles/latest/v1`, { timeout: 12_000 });
    const rows: DexBoostOrProfile[] = (data || []).filter(
      (r: DexBoostOrProfile) => r.chainId === 'solana' && r.tokenAddress,
    );
    const mints = [...new Set(rows.map((r) => r.tokenAddress!))];
    const pairs = await enrichMints(mints.slice(0, 60));
    const out: CandidateCoin[] = [];

    for (const row of rows.slice(0, 60)) {
      const mint = row.tokenAddress!;
      const pair = pairs.get(mint);
      if (pair) {
        const mapped = mapPair(pair, 'dex-profile');
        if (mapped) {
          const socials = linksToSocialFlags(row.links);
          out.push({
            ...mapped,
            hasTwitter: mapped.hasTwitter || socials.hasTwitter,
            hasTelegram: mapped.hasTelegram || socials.hasTelegram,
            hasWebsite: mapped.hasWebsite || socials.hasWebsite,
          });
        }
      }
    }
    return out;
  } catch (error) {
    logger.debug({ error }, 'DexScreener profiles fetch failed');
    return [];
  }
}

/** Enrich an arbitrary mint (e.g. from stream) with DexScreener market stats */
export async function enrichMintFromDex(mint: string): Promise<CandidateCoin | null> {
  const pairs = await enrichMints([mint]);
  const pair = pairs.get(mint);
  if (!pair) return null;
  return mapPair(pair, 'dex-pair');
}

export async function fetchAllDexCandidates(): Promise<CandidateCoin[]> {
  const [boosts, profiles] = await Promise.all([fetchDexBoosts(), fetchDexProfiles()]);
  return [...boosts, ...profiles];
}
