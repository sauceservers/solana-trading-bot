import { getDexAdapter, listDexAdapters, registerAllAdapters, SwapResult, WSOL_MINT } from 'outsmart';
import { logger } from '../helpers';
import { jupiterQuote } from '../helpers/jupiter-quote';
import { TradeJournal } from '../db/trade-journal';
import { OpenPosition, OutsmartDex, TradeSignal } from './types';
import { Trader } from './trader-kinds';

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
export class OutsmartTrader implements Trader {
  private ready = false;
  private readonly positions = new Map<string, OpenPosition>();

  constructor(
    private readonly config: TraderConfig,
    private readonly journal?: TradeJournal,
  ) {}

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

  async buy(signal: TradeSignal, signalId?: number | null): Promise<SwapResult | null> {
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
      let positionId: number | undefined;
      if (this.journal) {
        positionId = this.journal.openPosition({
          signalId,
          mode: 'live',
          dex: signal.dex,
          pool: signal.pool,
          mint: resolvedMint,
          entrySol: this.config.amountSol,
          tokenAmount: result.amountOut,
          pricing: 'live',
        });
        this.journal.recordFill({
          signalId,
          positionId,
          mode: 'live',
          dex: signal.dex,
          pool: signal.pool,
          mint: resolvedMint,
          side: 'buy',
          status: 'confirmed',
          amountInSol: result.amountIn ?? this.config.amountSol,
          amountOutTokens: result.amountOut,
          signature: result.txSignature,
          pricing: 'live',
        });
      }

      this.positions.set(key, {
        dex: signal.dex,
        pool: signal.pool,
        mint: resolvedMint,
        boughtAt: Date.now(),
        buySignature: result.txSignature,
        entrySol: this.config.amountSol,
        tokenAmount: result.amountOut,
        pricing: 'live',
        journalPositionId: positionId,
        journalSignalId: signalId ?? undefined,
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
      this.journal?.recordFill({
        signalId,
        mode: 'live',
        dex: signal.dex,
        pool: signal.pool,
        mint: mint || signal.pool,
        side: 'buy',
        status: 'failed',
        amountInSol: this.config.amountSol,
        signature: result.txSignature,
        pricing: 'live',
      });
      logger.warn({ dex: signal.dex, pool: signal.pool, signature: result.txSignature }, 'Buy not confirmed');
    }

    return result;
  }

  async sell(
    position: OpenPosition,
    percentage = 100,
    opts?: { exitReason?: string; signalId?: number | null },
  ): Promise<SwapResult | null> {
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

    const entrySol = position.entrySol ?? this.config.amountSol;
    const exitSol = result.amountOut;
    const holdMs = Date.now() - position.boughtAt;
    const exitReason = opts?.exitReason || 'manual';

    if (result.confirmed && percentage >= 100) {
      this.positions.delete(`${position.dex}:${position.pool}`);
      if (this.journal && position.journalPositionId != null && exitSol != null) {
        const pnlSol = exitSol - entrySol;
        const pnlPct = entrySol > 0 ? (pnlSol / entrySol) * 100 : 0;
        this.journal.closePosition({
          positionId: position.journalPositionId,
          exitSol,
          pnlSol,
          pnlPct,
          exitReason,
        });
      }
    }

    this.journal?.recordFill({
      signalId: opts?.signalId ?? position.journalSignalId ?? null,
      positionId: position.journalPositionId ?? null,
      mode: 'live',
      dex: position.dex,
      pool: position.pool,
      mint: position.mint,
      side: 'sell',
      status: result.confirmed ? 'confirmed' : 'failed',
      amountInSol: entrySol * (percentage / 100),
      amountOutSol: exitSol,
      signature: result.txSignature,
      pricing: 'live',
      pnlSol: exitSol != null ? exitSol - entrySol * (percentage / 100) : null,
      pnlPct:
        exitSol != null && entrySol > 0
          ? ((exitSol - entrySol * (percentage / 100)) / (entrySol * (percentage / 100))) * 100
          : null,
      holdMs,
      exitReason,
    });

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

  async markPositionSol(position: OpenPosition): Promise<number | null> {
    if (!position.tokenAmount) {
      return null;
    }
    const quote = await jupiterQuote({
      inputMint: position.mint,
      outputMint: this.config.quoteMint || WSOL_MINT,
      amountRaw: Math.floor(position.tokenAmount),
      slippageBps: this.config.sellSlippageBps,
    });
    return quote ? quote.outAmount / 1e9 : null;
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
