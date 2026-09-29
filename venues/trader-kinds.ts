import { SwapResult } from 'outsmart';
import { OpenPosition, OutsmartDex, TradeSignal } from './types';

/** Shared surface for live OutsmartTrader and PaperTrader. */
export interface Trader {
  init(): Promise<void>;
  isEnabled(dex: OutsmartDex): boolean;
  listPositions(): OpenPosition[];
  buy(signal: TradeSignal, signalId?: number | null): Promise<SwapResult | null>;
  sell(
    position: OpenPosition,
    percentage?: number,
    opts?: { exitReason?: string; signalId?: number | null },
  ): Promise<SwapResult | null>;
  sellViaJupiter(mint: string, percentage?: number): Promise<SwapResult | null>;
  /** Mark position value in SOL (paper uses Jupiter; live best-effort). */
  markPositionSol?(position: OpenPosition): Promise<number | null>;
}
