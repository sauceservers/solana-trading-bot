import { getDexAdapter, listDexAdapters, registerAllAdapters, SwapResult, WSOL_MINT } from 'outsmart';
import { logger } from '../helpers';
import { OpenPosition, OutsmartDex, TradeSignal } from './types';

export interface TraderConfig {
  enabledDexes: Set<OutsmartDex>;
  amountSol: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  tipSol: number;
  priorityFeeMicroLamports: number;
  /** Prefer quote mint when resolving which side of a pool to buy */
  quoteMint: string;
}

/**
 * Thin wrapper around Outsmart DEX adapters for multi-market buy/sell.
 * Covers PumpSwap, Raydium AMM/CPMM/CLMM/LaunchLab, Meteora, etc.
 */
export class OutsmartTrader {
  private ready = false;
  private readonly positions = new Map<string, OpenPosition>();

  constructor(private readonly config: TraderConfig) {}

  async init() {
    if (this.ready) {
      return;
    }
    await registerAllAdapters();
    const available = listDexAdapters().map((a) => a.name);
    logger.info({ available, enabled: [...this.config.enabledDexes] }, 'Outsmart DEX adapters registered');
    this.ready = true;
  }

  isEnabled(dex: OutsmartDex) {
    return this.config.enabledDexes.has(dex);
  }

  listPositions(): OpenPosition[] {
    return [...this.positions.values()];
  }

  async buy(signal: TradeSignal): Promise<SwapResult | null> {
    await this.init();

    if (!this.isEnabled(signal.dex)) {
      logger.debug({ dex: signal.dex, pool: signal.pool }, 'Skipping buy — DEX disabled');
      return null;
    }

    const adapter = getDexAdapter(signal.dex);
    if (!adapter.capabilities.canBuy) {
      logger.warn({ dex: signal.dex }, 'Adapter cannot buy');
      return null;
    }

    const mint = signal.mint ?? this.pickBaseMint(signal);
    const key = `${signal.dex}:${signal.pool}`;
    if (this.positions.has(key)) {
      logger.debug({ key }, 'Already have an open position for this pool');
      return null;
    }

    logger.info(
      { dex: signal.dex, pool: signal.pool, mint, amountSol: this.config.amountSol, source: signal.source },
      'Buying via Outsmart',
    );

    const result = await adapter.buy({
      tokenMint: mint,
      poolAddress: adapter.capabilities.isAggregator ? undefined : signal.pool,
      amountSol: this.config.amountSol,
      quoteMint: this.config.quoteMint,
      opts: {
        slippageBps: this.config.buySlippageBps,
        tipSol: this.config.tipSol,
        priorityFeeMicroLamports: this.config.priorityFeeMicroLamports,
      },
    });

    if (result.confirmed) {
      const resolvedMint = mint || result.amountOutToken || signal.pool;
      this.positions.set(key, {
        dex: signal.dex,
        pool: signal.pool,
        mint: resolvedMint,
        boughtAt: Date.now(),
        buySignature: result.txSignature,
      });
      logger.info(
        {
          dex: signal.dex,
          pool: signal.pool,
          signature: result.txSignature,
          out: result.amountOut,
          url: `https://solscan.io/tx/${result.txSignature}`,
        },
        'Buy confirmed',
      );
    } else {
      logger.warn({ dex: signal.dex, pool: signal.pool, signature: result.txSignature }, 'Buy not confirmed');
    }

    return result;
  }

  async sell(position: OpenPosition, percentage = 100): Promise<SwapResult | null> {
    await this.init();
    const adapter = getDexAdapter(position.dex);
    if (!adapter.capabilities.canSell) {
      logger.warn({ dex: position.dex }, 'Adapter cannot sell — try jupiter-ultra separately');
      return null;
    }

    logger.info({ dex: position.dex, pool: position.pool, mint: position.mint, percentage }, 'Selling via Outsmart');

    const result = await adapter.sell({
      tokenMint: position.mint,
      poolAddress: adapter.capabilities.isAggregator ? undefined : position.pool,
      percentage,
      quoteMint: this.config.quoteMint,
      opts: {
        slippageBps: this.config.sellSlippageBps,
        tipSol: this.config.tipSol,
        priorityFeeMicroLamports: this.config.priorityFeeMicroLamports,
      },
    });

    if (result.confirmed && percentage >= 100) {
      this.positions.delete(`${position.dex}:${position.pool}`);
    }

    logger.info(
      {
        dex: position.dex,
        pool: position.pool,
        signature: result.txSignature,
        confirmed: result.confirmed,
        url: `https://solscan.io/tx/${result.txSignature}`,
      },
      result.confirmed ? 'Sell confirmed' : 'Sell not confirmed',
    );

    return result;
  }

  /** Exit via Jupiter Ultra when the original venue cannot sell (or as fallback). */
  async sellViaJupiter(mint: string, percentage = 100): Promise<SwapResult | null> {
    await this.init();
    if (!this.isEnabled('jupiter-ultra')) {
      return null;
    }
    const adapter = getDexAdapter('jupiter-ultra');
    return adapter.sell({
      tokenMint: mint,
      percentage,
      opts: {
        slippageBps: this.config.sellSlippageBps,
        tipSol: this.config.tipSol,
      },
    });
  }

  async findPool(dex: OutsmartDex, tokenMint: string, quoteMint = this.config.quoteMint) {
    await this.init();
    const adapter = getDexAdapter(dex);
    if (!adapter.findPool) {
      return null;
    }
    return adapter.findPool(tokenMint, quoteMint);
  }

  private pickBaseMint(signal: TradeSignal): string | undefined {
    const quote = this.config.quoteMint;
    if (signal.tokenA && signal.tokenB) {
      if (signal.tokenA === quote || signal.tokenA === WSOL_MINT) {
        return signal.tokenB;
      }
      if (signal.tokenB === quote || signal.tokenB === WSOL_MINT) {
        return signal.tokenA;
      }
      return signal.tokenA;
    }
    return undefined;
  }
}
