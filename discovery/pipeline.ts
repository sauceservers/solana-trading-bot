import { logger, sleep } from '../helpers';
import { TradeSignal } from '../venues/types';
import { getSelectionProfile } from './profiles';
import { enrichMintFromDex, fetchAllDexCandidates } from './providers/dexscreener';
import { fetchAllPumpCandidates } from './providers/pump';
import { rankCandidates, scoreCandidate } from './score';
import {
  CandidateCoin,
  DiscoveryRuntimeConfig,
  RankedCoin,
  SelectionProfile,
} from './types';

export type PickHandler = (pick: RankedCoin) => void | Promise<void>;

/**
 * Continuously discovers meme-coin candidates from Pump.fun + DexScreener,
 * scores them under a selection profile, and emits only the coins worth buying.
 */
export class DiscoveryPipeline {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly seenBuys = new Map<string, number>();
  private lastBoard: RankedCoin[] = [];
  private readonly profile: SelectionProfile;

  constructor(
    private readonly config: DiscoveryRuntimeConfig,
    private readonly onPick?: PickHandler,
  ) {
    this.profile = getSelectionProfile(config.profile);
  }

  getProfile() {
    return this.profile;
  }

  getLastBoard() {
    return this.lastBoard;
  }

  async start() {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    logger.info(
      {
        mode: this.config.mode,
        profile: this.profile.name,
        minScore: this.profile.minScore,
        description: this.profile.description,
      },
      'Discovery pipeline started — ranking which meme coins to buy',
    );
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One discovery cycle: fetch → score → rank → optionally emit picks */
  async tick(): Promise<RankedCoin[]> {
    const candidates = await this.collectCandidates();
    const ranked = rankCandidates(candidates, this.profile, this.config.topN);
    this.lastBoard = ranked;

    this.logBoard(ranked);

    if (this.config.mode === 'trade' && this.onPick) {
      for (const pick of ranked) {
        if (pick.score.total < this.profile.minScore) continue;
        if (this.recentlyPicked(pick.candidate.mint)) continue;
        this.seenBuys.set(pick.candidate.mint, Date.now());
        await this.onPick(pick);
      }
    }

    return ranked;
  }

  /**
   * Score a stream-originated signal before buying.
   * Returns null if the coin fails gates / min score.
   */
  async evaluateStreamSignal(signal: TradeSignal): Promise<RankedCoin | null> {
    if (!this.config.scoreStreamSignals) {
      // Pass-through: treat stream as already selected
      return {
        candidate: {
          mint: signal.mint || signal.pool,
          symbol: (signal.mint || signal.pool).slice(0, 6),
          name: 'stream',
          source: signal.source === 'bonding-complete' ? 'stream-bonding-complete' : 'stream-new-pool',
          discoveredAt: signal.discoveredAt,
          dex: signal.dex,
          pool: signal.pool,
        },
        score: { total: 100, factors: {}, rejects: [], reasons: ['stream passthrough'] },
      };
    }

    let candidate: CandidateCoin | null = null;
    if (signal.mint) {
      candidate = await enrichMintFromDex(signal.mint);
    }

    if (!candidate) {
      candidate = {
        mint: signal.mint || signal.tokenA || signal.tokenB || signal.pool,
        symbol: (signal.mint || signal.pool).slice(0, 6),
        name: 'stream-candidate',
        source: signal.source === 'bonding-complete' ? 'stream-bonding-complete' : 'stream-new-pool',
        discoveredAt: signal.discoveredAt,
        dex: signal.dex,
        pool: signal.pool,
        // Without market data, only graduation-style stream events clear a soft path
        marketCapUsd: signal.source === 'bonding-complete' ? 50_000 : undefined,
        bondingProgressPct: signal.source === 'bonding-complete' ? 100 : undefined,
        graduated: signal.source === 'bonding-complete',
      };
    } else {
      candidate = {
        ...candidate,
        dex: signal.dex || candidate.dex,
        pool: signal.pool || candidate.pool,
        source: signal.source === 'bonding-complete' ? 'stream-bonding-complete' : 'stream-new-pool',
      };
    }

    const ranked = scoreCandidate(candidate, this.profile);
    if (ranked.score.rejects.length || ranked.score.total < this.profile.minScore) {
      logger.info(
        {
          mint: candidate.mint,
          score: ranked.score.total,
          rejects: ranked.score.rejects,
          reasons: ranked.score.reasons,
          profile: this.profile.name,
        },
        'Stream coin rejected by selection profile',
      );
      return null;
    }

    logger.info(
      {
        mint: candidate.mint,
        symbol: candidate.symbol,
        score: ranked.score.total,
        reasons: ranked.score.reasons,
        profile: this.profile.name,
      },
      'Stream coin passed selection',
    );
    return ranked;
  }

  private async collectCandidates(): Promise<CandidateCoin[]> {
    const tasks: Promise<CandidateCoin[]>[] = [];
    if (this.config.enablePump) tasks.push(fetchAllPumpCandidates());
    if (this.config.enableDexScreener) tasks.push(fetchAllDexCandidates());

    const batches = await Promise.all(tasks);
    return ([] as CandidateCoin[]).concat(...batches);
  }

  private recentlyPicked(mint: string, ttlMs = 30 * 60_000) {
    const at = this.seenBuys.get(mint);
    if (!at) return false;
    if (Date.now() - at > ttlMs) {
      this.seenBuys.delete(mint);
      return false;
    }
    return true;
  }

  private logBoard(ranked: RankedCoin[]) {
    const eligible = ranked.filter((r) => r.score.total >= this.profile.minScore);
    logger.info(
      {
        profile: this.profile.name,
        mode: this.config.mode,
        scanned: ranked.length,
        eligible: eligible.length,
        minScore: this.profile.minScore,
      },
      'Meme coin selection board',
    );

    for (const row of ranked.slice(0, Math.min(10, this.config.topN))) {
      const c = row.candidate;
      logger.info(
        {
          rankScore: row.score.total,
          symbol: c.symbol,
          mint: c.mint,
          source: c.source,
          mcap: c.marketCapUsd,
          liq: c.liquidityUsd,
          bonding: c.bondingProgressPct,
          reasons: row.score.reasons,
          rejects: row.score.rejects,
        },
        row.score.total >= this.profile.minScore ? 'PICK' : 'watch',
      );
    }
  }
}

/** Single-shot explore helper for CLI */
export async function exploreOnce(config: DiscoveryRuntimeConfig): Promise<RankedCoin[]> {
  const pipeline = new DiscoveryPipeline(config);
  const board = await pipeline.tick();
  // tiny delay so pino flushes pretty transport in scripts
  await sleep(50);
  return board;
}
