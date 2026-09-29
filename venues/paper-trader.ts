import { randomBytes } from 'crypto';
import { SwapResult } from 'outsmart';
import { logger } from '../helpers';
import { jupiterQuote, solToLamports, WSOL } from '../helpers/jupiter-quote';
import { TradeJournal } from '../db/trade-journal';
import { OpenPosition, OutsmartDex, TradeSignal } from './types';
import { Trader } from './trader-kinds';
import { TraderConfig } from './trader';

function paperSig(prefix: string): string {
  return `paper_${prefix}_${randomBytes(16).toString('hex')}`;
}

/**
 * Simulates fills without sending transactions.
 * Uses Jupiter quotes when a route exists; otherwise synthetic sizing tagged in the journal.
 */
export class PaperTrader implements Trader {
  private readonly positions = new Map<string, OpenPosition>();
  private ready = false;

  constructor(
    private readonly config: TraderConfig,
    private readonly journal: TradeJournal,
  ) {}

  async init() {
    if (this.ready) {
      return;
    }
    this.ready = true;
    logger.info(
      { enabled: [...this.config.enabledDexes], amountSol: this.config.amountSol },
      'Paper trader ready (no on-chain sends)',
    );
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
      return null;
    }

    const mint = signal.mint ?? this.pickBaseMint(signal);
    if (!mint) {
      logger.warn({ pool: signal.pool }, 'Paper buy skipped — mint unknown');
      return null;
    }

    const key = `${signal.dex}:${signal.pool}`;
    if (this.positions.has(key)) {
      return null;
    }

    const entrySol = this.config.amountSol;
    let tokenAmount: number | undefined;
    let pricing: OpenPosition['pricing'] = 'synthetic';
    let priceImpactPct: number | undefined;

    const quote = await jupiterQuote({
      inputMint: this.config.quoteMint || WSOL,
      outputMint: mint,
      amountRaw: solToLamports(entrySol),
      slippageBps: this.config.buySlippageBps,
    });

    if (quote) {
      // outAmount is raw token units; keep raw for later sell quotes
      tokenAmount = quote.outAmount;
      pricing = 'jupiter';
      priceImpactPct = quote.priceImpactPct;
    } else {
      // Synthetic: 1 SOL → 1e6 raw units placeholder (filterable via pricing column)
      tokenAmount = Math.round(entrySol * 1_000_000);
      pricing = 'synthetic';
    }

    const signature = paperSig('buy');
    const positionId = this.journal.openPosition({
      signalId,
      mode: 'paper',
      dex: signal.dex,
      pool: signal.pool,
      mint,
      entrySol,
      tokenAmount,
      pricing,
    });

    const position: OpenPosition = {
      dex: signal.dex,
      pool: signal.pool,
      mint,
      boughtAt: Date.now(),
      buySignature: signature,
      entrySol,
      tokenAmount,
      pricing,
      journalPositionId: positionId,
      journalSignalId: signalId ?? undefined,
    };
    this.positions.set(key, position);

    this.journal.recordFill({
      signalId,
      positionId,
      mode: 'paper',
      dex: signal.dex,
      pool: signal.pool,
      mint,
      side: 'buy',
      status: 'confirmed',
      amountInSol: entrySol,
      amountOutTokens: tokenAmount,
      priceSolPerToken: tokenAmount > 0 ? entrySol / tokenAmount : null,
      signature,
      pricing,
      meta: { priceImpactPct, synthetic: pricing === 'synthetic' },
    });

    logger.info(
      {
        dex: signal.dex,
        pool: signal.pool,
        mint,
        entrySol,
        tokenAmount,
        pricing,
        signature,
      },
      'Paper buy filled',
    );

    return {
      txSignature: signature,
      confirmed: true,
      amountIn: entrySol,
      amountInToken: 'SOL',
      amountOut: tokenAmount,
      amountOutToken: mint,
      priceImpactPct,
      dex: signal.dex,
      poolAddress: signal.pool,
    };
  }

  async sell(
    position: OpenPosition,
    percentage = 100,
    opts?: { exitReason?: string; signalId?: number | null },
  ): Promise<SwapResult | null> {
    await this.init();
    const key = `${position.dex}:${position.pool}`;
    const open = this.positions.get(key) || position;
    const tokenAmount = open.tokenAmount ?? 0;
    const sellRaw = Math.max(1, Math.floor((tokenAmount * percentage) / 100));
    const entrySol = open.entrySol ?? this.config.amountSol;
    const exitReason = opts?.exitReason || 'manual';

    let exitSol: number;
    let pricing = open.pricing || 'synthetic';

    const quote = await jupiterQuote({
      inputMint: open.mint,
      outputMint: this.config.quoteMint || WSOL,
      amountRaw: sellRaw,
      slippageBps: this.config.sellSlippageBps,
    });

    if (quote) {
      exitSol = quote.outAmount / 1e9;
      pricing = 'jupiter';
    } else if (pricing === 'synthetic') {
      // Flat-ish synthetic exit with sell slippage haircut
      exitSol = entrySol * (percentage / 100) * (1 - this.config.sellSlippageBps / 10_000);
    } else {
      // Had a real entry quote once but sell route missing — mark as unresolved haircut
      exitSol = entrySol * (percentage / 100) * 0.95;
      pricing = 'estimate';
    }

    const pnlSol = exitSol - entrySol * (percentage / 100);
    const pnlPct = entrySol > 0 ? (pnlSol / (entrySol * (percentage / 100))) * 100 : 0;
    const holdMs = Date.now() - open.boughtAt;
    const signature = paperSig('sell');

    if (open.journalPositionId && percentage >= 100) {
      this.journal.closePosition({
        positionId: open.journalPositionId,
        exitSol,
        pnlSol,
        pnlPct,
        exitReason,
      });
    }

    this.journal.recordFill({
      signalId: opts?.signalId ?? open.journalSignalId ?? null,
      positionId: open.journalPositionId ?? null,
      mode: 'paper',
      dex: open.dex,
      pool: open.pool,
      mint: open.mint,
      side: 'sell',
      status: 'confirmed',
      amountInSol: entrySol * (percentage / 100),
      amountOutTokens: sellRaw,
      amountOutSol: exitSol,
      priceSolPerToken: sellRaw > 0 ? exitSol / sellRaw : null,
      signature,
      pricing,
      pnlSol,
      pnlPct,
      holdMs,
      exitReason,
    });

    if (percentage >= 100) {
      this.positions.delete(key);
    }

    logger.info(
      {
        dex: open.dex,
        pool: open.pool,
        mint: open.mint,
        exitSol,
        pnlSol,
        pnlPct,
        holdMs,
        exitReason,
        pricing,
        signature,
      },
      'Paper sell filled',
    );

    return {
      txSignature: signature,
      confirmed: true,
      amountIn: sellRaw,
      amountInToken: open.mint,
      amountOut: exitSol,
      amountOutToken: 'SOL',
      dex: open.dex,
      poolAddress: open.pool,
    };
  }

  async sellViaJupiter(mint: string, percentage = 100): Promise<SwapResult | null> {
    const position = this.listPositions().find((p) => p.mint === mint);
    if (!position) {
      return null;
    }
    return this.sell(position, percentage, { exitReason: 'jupiter-fallback' });
  }

  async markPositionSol(position: OpenPosition): Promise<number | null> {
    const tokenAmount = position.tokenAmount;
    if (!tokenAmount) {
      return null;
    }
    const quote = await jupiterQuote({
      inputMint: position.mint,
      outputMint: this.config.quoteMint || WSOL,
      amountRaw: Math.floor(tokenAmount),
      slippageBps: this.config.sellSlippageBps,
    });
    if (!quote) {
      return null;
    }
    return quote.outAmount / 1e9;
  }

  private pickBaseMint(signal: TradeSignal): string | undefined {
    const quote = this.config.quoteMint || WSOL;
    if (signal.tokenA && signal.tokenB) {
      if (signal.tokenA === quote || signal.tokenA === WSOL) {
        return signal.tokenB;
      }
      if (signal.tokenB === quote || signal.tokenB === WSOL) {
        return signal.tokenA;
      }
      return signal.tokenA;
    }
    return signal.mint;
  }
}
