import { Mutex } from 'async-mutex';
import { logger, sleep } from './helpers';
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
}

/**
 * Strategy shell around Outsmart multi-DEX execution.
 * Detection comes from StreamWatcher; this class owns buy gating + optional auto-sell.
 */
export class Bot {
  private readonly mutex = new Mutex();
  private busy = false;

  constructor(
    private readonly trader: OutsmartTrader,
    private readonly config: BotRuntimeConfig,
  ) {}

  async onSignal(signal: TradeSignal) {
    if (!this.config.autoBuy) {
      logger.info({ dex: signal.dex, pool: signal.pool }, 'AUTO_BUY=false — signal ignored');
      return;
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

      if (this.config.holdMs > 0) {
        logger.debug({ holdMs: this.config.holdMs, pool: signal.pool }, 'Holding before auto-sell');
        await sleep(this.config.holdMs);
      } else if (this.config.autoSellDelayMs > 0) {
        await sleep(this.config.autoSellDelayMs);
      }

      const positions = this.trader.listPositions().filter((p) => p.pool === signal.pool);
      for (const position of positions) {
        for (let i = 0; i < this.config.maxSellRetries; i++) {
          try {
            const sold = await this.trader.sell(position, 100);
            if (sold?.confirmed) {
              break;
            }
            // Fallback liquidation path
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
}
