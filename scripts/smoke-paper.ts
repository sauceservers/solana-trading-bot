/**
 * Offline paper-trade smoke: simulate buy→hold→sell on a liquid mint via Jupiter marks.
 * Usage: npx ts-node scripts/smoke-paper.ts
 */
import { TradeJournal } from '../db/trade-journal';
import { PaperTrader } from '../venues/paper-trader';
import { OutsmartDex, TradeSignal } from '../venues/types';

const WSOL = 'So11111111111111111111111111111111111111112';
// BONK — liquid enough for Jupiter quotes
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

async function main() {
  const journal = new TradeJournal('./data/trades.sqlite');
  journal.startRun('paper', { smoke: true, script: 'smoke-paper' });

  const trader = new PaperTrader(
    {
      enabledDexes: new Set<OutsmartDex>(['jupiter-ultra', 'pumpfun-amm', 'raydium-cpmm']),
      amountSol: 0.01,
      buySlippageBps: 100,
      sellSlippageBps: 100,
      tipSol: 0,
      priorityFeeMicroLamports: 0,
      quoteMint: WSOL,
    },
    journal,
  );
  await trader.init();

  const signal: TradeSignal = {
    dex: 'jupiter-ultra',
    pool: 'smoke-pool-bonk',
    mint: BONK,
    tokenA: WSOL,
    tokenB: BONK,
    source: 'manual',
    discoveredAt: Date.now(),
  };

  const signalId = journal.recordSignal(signal, { accepted: true });
  const buy = await trader.buy(signal, signalId);
  if (!buy?.confirmed) {
    throw new Error('paper buy failed');
  }
  console.log('BUY', {
    pricing: trader.listPositions()[0]?.pricing,
    entrySol: trader.listPositions()[0]?.entrySol,
    tokenAmount: trader.listPositions()[0]?.tokenAmount,
    sig: buy.txSignature,
  });

  const pos = trader.listPositions()[0];
  const mark = pos ? await trader.markPositionSol(pos) : null;
  console.log('MARK_SOL', mark);

  const sell = await trader.sell(pos, 100, { exitReason: 'smoke', signalId });
  console.log('SELL', {
    confirmed: sell?.confirmed,
    outSol: sell?.amountOut,
    sig: sell?.txSignature,
  });

  console.log('SUMMARY', journal.summary());
  journal.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
