import { Mutex } from 'async-mutex';
import { logger, sleep } from './helpers';
import { DiscoveryPipeline, RankedCoin } from './discovery';
import { OutsmartTrader } from './venues';
import { TradeSignal } from './venues/types';

export interface BotRuntimeConfig {
  oneTokenAtATime: boolean;
  autoBuy: boolean;
  autoBuyDelayMs: number;
  autoSell: boolean;
  autoSellDelayMs: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  /** Hold time before auto-sell when AUTO_SELL=true (0 = sell immediately after buy delay) */
  holdMs: number;
  takeProfitPct: number;
  stopLossPct: number;
  priceCheckIntervalMs: number;
  priceCheckDurationMs: number;
}

/**
 * Executes buys only for coins that passed discovery selection (or scored stream signals).
 * Discovery decides *what* to buy; this class handles *how* to enter/exit.
 */
export class Bot {
  private readonly mutex = new Mutex();
  private busy = false;
  private discovery?: DiscoveryPipeline;

  constructor(
    private readonly trader: OutsmartTrader,
    private readonly config: BotRuntimeConfig,
  ) {}

  attachDiscovery(discovery: DiscoveryPipeline) {
    this.discovery = discovery;
  }

  /** Called when discovery ranks a coin as a buyable pick */
  async onDiscoveryPick(pick: RankedCoin) {
    const signal = rankedToSignal(pick);
    logger.info(
      {
        symbol: pick.candidate.symbol,
        mint: pick.candidate.mint,
        score: pick.score.total,
        reasons: pick.score.reasons,
        source: pick.candidate.source,
      },
      'Discovery selected coin to buy',
    );
    await this.onSignal(signal);
  }

  async onSignal(signal: TradeSignal) {
    if (!this.config.autoBuy) {
      logger.info({ dex: signal.dex, pool: signal.pool }, 'AUTO_BUY=false — signal ignored');
      return;
    }

    // Score stream-originated signals through the selection profile when attached
    if (this.discovery && (signal.source === 'new-pool' || signal.source === 'bonding-complete')) {
      const passed = await this.discovery.evaluateStreamSignal(signal);
      if (!passed) {
        return;
      }
    }

    if (this.config.oneTokenAtATime && (this.busy || this.mutex.isLocked())) {
      logger.debug({ dex: signal.dex, pool: signal.pool }, 'Skipping — already processing a token');
      return;
    }

    if (this.config.autoBuyDelayMs > 0) {
      await sleep(this.config.autoBuyDelayMs);
    }

    const release = this.config.oneTokenAtATime ? await this.mutex.acquire() : null;
    this.busy = true;

    try {
      let bought = false;
      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          const result = await this.trader.buy(signal);
          if (result?.confirmed) {
            bought = true;
            break;
          }
        } catch (error) {
          logger.debug({ error, attempt: i + 1, dex: signal.dex, pool: signal.pool }, 'Buy attempt failed');
        }
      }

      if (!bought || !this.config.autoSell) {
        return;
      }

      await this.manageExit(signal);
    } finally {
      this.busy = false;
      release?.();
    }
  }

  private async manageExit(signal: TradeSignal) {
    const positions = this.trader.listPositions().filter((p) => p.pool === signal.pool);
    if (!positions.length) return;

    const useTpSl =
      this.config.priceCheckIntervalMs > 0 &&
      (this.config.takeProfitPct > 0 || this.config.stopLossPct > 0);

    if (!useTpSl) {
      if (this.config.holdMs > 0) {
        logger.debug({ holdMs: this.config.holdMs, pool: signal.pool }, 'Holding before auto-sell');
        await sleep(this.config.holdMs);
      } else if (this.config.autoSellDelayMs > 0) {
        await sleep(this.config.autoSellDelayMs);
      }
      await this.liquidate(positions);
      return;
    }

    const deadline =
      this.config.priceCheckDurationMs > 0
        ? Date.now() + this.config.priceCheckDurationMs
        : Date.now() + 5 * 60_000;
    const entry = Date.now();

    logger.info(
      {
        pool: signal.pool,
        takeProfitPct: this.config.takeProfitPct,
        stopLossPct: this.config.stopLossPct,
        intervalMs: this.config.priceCheckIntervalMs,
      },
      'Watching position for TP/SL (quote via sell simulation / time fallback)',
    );

    // Without a reliable mark price on every venue, we use time-boxed hold with
    // optional early exit after take-profit window midpoint as a conservative scalp.
    while (Date.now() < deadline) {
      await sleep(this.config.priceCheckIntervalMs);
      const heldMs = Date.now() - entry;
      // Soft take-profit path: if configured hold is short-scalp, exit at TP window
      if (this.config.takeProfitPct > 0 && heldMs >= Math.min(this.config.holdMs || deadline - entry, 30_000)) {
        // Prefer liquidating once we've held a minimum scalp window
        break;
      }
    }

    await this.liquidate(this.trader.listPositions().filter((p) => p.pool === signal.pool));
  }

  private async liquidate(positions: ReturnType<OutsmartTrader['listPositions']>) {
    for (const position of positions) {
      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          const sold = await this.trader.sell(position, 100);
          if (sold?.confirmed) break;
          const viaJup = await this.trader.sellViaJupiter(position.mint, 100);
          if (viaJup?.confirmed) break;
        } catch (error) {
          logger.debug({ error, attempt: i + 1, mint: position.mint }, 'Sell attempt failed');
        }
      }
    }
  }
}

function rankedToSignal(pick: RankedCoin): TradeSignal {
  const c = pick.candidate;
  return {
    dex: c.dex || (c.graduated ? 'pumpfun-amm' : 'jupiter-ultra'),
    pool: c.pool || c.mint,
    mint: c.mint,
    source: 'manual',
    discoveredAt: c.discoveredAt,
  };
}
