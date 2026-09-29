import { BondingCompleteEvent, NewPoolEvent, SubscriptionPreset, WsEventStream } from 'outsmart';
import { logger } from '../helpers';
import { STREAM_DEX_TO_ADAPTER, TradeSignal } from './types';

export interface StreamWatcherConfig {
  rpcUrl: string;
  wsUrl?: string;
  /** Which Outsmart stream presets to run in parallel */
  presets: SubscriptionPreset[];
  onSignal: (signal: TradeSignal) => void;
}

/**
 * Watches multiple Outsmart WS presets for new pools / bonding completions.
 * Maps stream DEX labels onto Outsmart adapter names used for buys.
 */
export class StreamWatcher {
  private streams: WsEventStream[] = [];

  constructor(private readonly config: StreamWatcherConfig) {}

  async start() {
    for (const preset of this.config.presets) {
      const stream = new WsEventStream({
        rpcUrl: this.config.rpcUrl,
        wsUrl: this.config.wsUrl,
        logLevel: 'silent',
      });

      stream.on('NewPool', (event: NewPoolEvent) => this.handleNewPool(event));
      stream.on('BondingComplete', (event: BondingCompleteEvent) => this.handleBondingComplete(event));
      stream.on('error', (error: unknown) => {
        logger.debug({ preset, error }, 'Stream error');
      });

      try {
        await stream.start(preset);
        this.streams.push(stream);
        logger.info({ preset }, 'Outsmart stream started');
      } catch (error) {
        logger.error({ preset, error }, 'Failed to start Outsmart stream preset');
      }
    }
  }

  async stop() {
    await Promise.all(this.streams.map((s) => s.stop()));
    this.streams = [];
  }

  private handleNewPool(event: NewPoolEvent) {
    const dex = STREAM_DEX_TO_ADAPTER[event.dex];
    if (!dex) {
      logger.trace({ streamDex: event.dex }, 'No adapter mapping for stream DEX');
      return;
    }

    logger.info(
      {
        dex,
        pool: event.pool,
        tokenA: event.tokenA,
        tokenB: event.tokenB,
        signature: event.signature,
      },
      'New pool detected',
    );

    this.config.onSignal({
      dex,
      pool: event.pool,
      tokenA: event.tokenA,
      tokenB: event.tokenB,
      source: 'new-pool',
      discoveredAt: Date.now(),
      signature: event.signature,
    });
  }

  private handleBondingComplete(event: BondingCompleteEvent) {
    // Pump bonding → PumpSwap / migrated AMM pool
    const pool = event.migrationPool || event.bondingCurve;
    const dex = event.migrationPool ? STREAM_DEX_TO_ADAPTER.pumpswap : STREAM_DEX_TO_ADAPTER.pumpfun;

    logger.info(
      {
        dex,
        mint: event.mint,
        pool,
        signature: event.signature,
      },
      'Bonding complete / migration detected',
    );

    this.config.onSignal({
      dex: dex ?? 'pumpfun-amm',
      pool,
      mint: event.mint,
      source: 'bonding-complete',
      discoveredAt: Date.now(),
      signature: event.signature,
    });
  }
}
