import { Mutex } from 'async-mutex';
import { logger, sleep } from './helpers';
import { TradeJournal } from './db/trade-journal';
import { TradeSignal } from './venues/types';
import { Trader } from './venues/trader-kinds';

export interface BotRuntimeConfig {
  oneTokenAtATime: boolean;
  autoBuy: boolean;
  autoBuyDelayMs: number;
  autoSell: boolean;
  autoSellDelayMs: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  /** Max hold time before forced exit when AUTO_SELL=true (0 = use delay / immediate TP-SL only) */
  holdMs: number;
  takeProfitPct: number;
  stopLossPct: number;
  priceCheckIntervalMs: number;
  paperTrade: boolean;
}

/**
 * Strategy shell around live or paper execution.
 * Detection comes from StreamWatcher; this class owns buy gating, TP/SL hold, journaling.
 */
export class Bot {
  private readonly mutex = new Mutex();
  private busy = false;

  constructor(
    private readonly trader: Trader,
    private readonly config: BotRuntimeConfig,
    private readonly journal?: TradeJournal,
  ) {}

  async onSignal(signal: TradeSignal) {
    if (!this.config.autoBuy) {
      this.journal?.recordSignal(signal, { accepted: false, skipReason: 'AUTO_BUY=false' });
      logger.info({ dex: signal.dex, pool: signal.pool }, 'AUTO_BUY=false — signal recorded, not traded');
      return;
    }

    if (this.config.oneTokenAtATime && (this.busy || this.mutex.isLocked())) {
      this.journal?.recordSignal(signal, { accepted: false, skipReason: 'busy' });
      logger.debug({ dex: signal.dex, pool: signal.pool }, 'Skipping — already processing a token');
      return;
    }

    const signalId = this.journal?.recordSignal(signal, { accepted: true });

    if (this.config.autoBuyDelayMs > 0) {
      await sleep(this.config.autoBuyDelayMs);
    }

    const release = this.config.oneTokenAtATime ? await this.mutex.acquire() : null;
    this.busy = true;

    try {
      let bought = false;
      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          const result = await this.trader.buy(signal, signalId);
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

      const positions = this.trader.listPositions().filter((p) => p.pool === signal.pool);
      for (const position of positions) {
        const exitReason = await this.waitForExit(position);
        for (let i = 0; i < this.config.maxSellRetries; i++) {
          try {
            const sold = await this.trader.sell(position, 100, { exitReason, signalId });
            if (sold?.confirmed) {
              break;
            }
            const viaJup = await this.trader.sellViaJupiter(position.mint, 100);
            if (viaJup?.confirmed) {
              break;
            }
          } catch (error) {
            logger.debug({ error, attempt: i + 1, mint: position.mint }, 'Sell attempt failed');
          }
        }
      }
    } finally {
      this.busy = false;
      release?.();
    }
  }

  /**
   * Poll marks until take-profit, stop-loss, or max hold.
   * Falls back to AUTO_SELL_DELAY when holdMs=0 and no TP/SL triggers.
   */
  private async waitForExit(position: {
    pool: string;
    mint: string;
    boughtAt: number;
    entrySol?: number;
  }): Promise<string> {
    const takeProfit = this.config.takeProfitPct;
    const stopLoss = this.config.stopLossPct;
    const interval = Math.max(250, this.config.priceCheckIntervalMs || 2000);
    const deadline =
      this.config.holdMs > 0
        ? position.boughtAt + this.config.holdMs
        : this.config.autoSellDelayMs > 0
          ? Date.now() + this.config.autoSellDelayMs
          : Date.now();

    // Immediate exit path
    if (this.config.holdMs <= 0 && this.config.autoSellDelayMs <= 0 && takeProfit <= 0 && stopLoss <= 0) {
      return 'immediate';
    }

    while (Date.now() < deadline) {
      const entrySol = position.entrySol;
      if (entrySol && entrySol > 0 && this.trader.markPositionSol && (takeProfit > 0 || stopLoss > 0)) {
        const open = this.trader.listPositions().find((p) => p.pool === position.pool);
        if (!open) {
          return 'position-gone';
        }
        const mark = await this.trader.markPositionSol(open);
        if (mark != null) {
          const pnlPct = ((mark - entrySol) / entrySol) * 100;
          logger.debug(
            { pool: position.pool, mark, entrySol, pnlPct, takeProfit, stopLoss },
            'Mark-to-market',
          );
          if (takeProfit > 0 && pnlPct >= takeProfit) {
            return 'take-profit';
          }
          if (stopLoss > 0 && pnlPct <= -stopLoss) {
            return 'stop-loss';
          }
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(interval, remaining));
    }

    return this.config.holdMs > 0 ? 'max-hold' : 'sell-delay';
  }
}
