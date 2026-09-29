import { version } from './package.json';
import {
  AUTO_BUY,
  AUTO_BUY_DELAY,
  AUTO_SELL,
  AUTO_SELL_DELAY,
  BUY_SLIPPAGE,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  DISCOVERY_ENABLE_DEXSCREENER,
  DISCOVERY_ENABLE_PUMP,
  DISCOVERY_ENABLED,
  DISCOVERY_MODE,
  DISCOVERY_POLL_INTERVAL_MS,
  DISCOVERY_TOP_N,
  ENABLED_DEXES,
  LOG_LEVEL,
  MAX_BUY_RETRIES,
  MAX_SELL_RETRIES,
  ONE_TOKEN_AT_A_TIME,
  PRICE_CHECK_DURATION,
  PRICE_CHECK_INTERVAL,
  PRIVATE_KEY,
  QUOTE_AMOUNT,
  QUOTE_MINT,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  SCORE_STREAM_SIGNALS,
  SELECTION_PROFILE,
  SELL_SLIPPAGE,
  STOP_LOSS,
  STREAM_PRESETS,
  TAKE_PROFIT,
  TIP_SOL,
  getSelectionProfile,
  getWallet,
  logger,
} from './helpers';
import { Bot } from './bot';
import { DiscoveryPipeline } from './discovery';
import { OutsmartTrader, StreamWatcher } from './venues';
import { WSOL_MINT } from 'outsmart';

function resolveQuoteMint(): string {
  const q = QUOTE_MINT.toUpperCase();
  if (q === 'WSOL' || q === 'SOL') {
    return WSOL_MINT;
  }
  if (q === 'USDC') {
    return 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  }
  return QUOTE_MINT;
}

async function main() {
  logger.level = LOG_LEVEL;
  logger.info(`Outsmart multi-DEX meme bot starting (v${version})`);

  if (!PRIVATE_KEY) {
    logger.error('PRIVATE_KEY is required to run the trading bot. Use `npm run discover` to explore picks without a wallet.');
    process.exit(1);
  }

  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteMint = resolveQuoteMint();
  const amountSol = Number(QUOTE_AMOUNT);
  const profile = getSelectionProfile(SELECTION_PROFILE);

  const trader = new OutsmartTrader({
    enabledDexes: ENABLED_DEXES,
    amountSol,
    buySlippageBps: Math.round(BUY_SLIPPAGE * 100),
    sellSlippageBps: Math.round(SELL_SLIPPAGE * 100),
    tipSol: TIP_SOL,
    priorityFeeMicroLamports: COMPUTE_UNIT_PRICE,
    quoteMint,
  });
  await trader.init();

  const bot = new Bot(trader, {
    oneTokenAtATime: ONE_TOKEN_AT_A_TIME,
    autoBuy: AUTO_BUY,
    autoBuyDelayMs: AUTO_BUY_DELAY,
    autoSell: AUTO_SELL,
    autoSellDelayMs: AUTO_SELL_DELAY,
    maxBuyRetries: MAX_BUY_RETRIES,
    maxSellRetries: MAX_SELL_RETRIES,
    holdMs: PRICE_CHECK_DURATION,
    takeProfitPct: TAKE_PROFIT,
    stopLossPct: STOP_LOSS,
    priceCheckIntervalMs: PRICE_CHECK_INTERVAL,
    priceCheckDurationMs: PRICE_CHECK_DURATION,
  });

  const discovery = new DiscoveryPipeline(
    {
      enabled: DISCOVERY_ENABLED,
      mode: DISCOVERY_MODE,
      profile: profile.name,
      pollIntervalMs: DISCOVERY_POLL_INTERVAL_MS,
      topN: DISCOVERY_TOP_N,
      enablePump: DISCOVERY_ENABLE_PUMP,
      enableDexScreener: DISCOVERY_ENABLE_DEXSCREENER,
      scoreStreamSignals: SCORE_STREAM_SIGNALS,
    },
    (pick) => bot.onDiscoveryPick(pick),
  );
  bot.attachDiscovery(discovery);

  logger.info('------- CONFIGURATION -------');
  logger.info(`Wallet: ${wallet.publicKey.toString()}`);
  logger.info(`RPC: ${RPC_ENDPOINT}`);
  logger.info(`Quote: ${QUOTE_AMOUNT} ${QUOTE_MINT} (${quoteMint})`);
  logger.info(`Enabled DEX adapters: ${[...ENABLED_DEXES].join(', ')}`);
  logger.info(`Stream presets: ${STREAM_PRESETS.join(', ')}`);
  logger.info(`Selection profile: ${profile.name} — ${profile.description}`);
  logger.info(`Discovery: enabled=${DISCOVERY_ENABLED} mode=${DISCOVERY_MODE} minScore=${profile.minScore}`);
  logger.info(`Auto buy: ${AUTO_BUY} | Auto sell: ${AUTO_SELL} | Score streams: ${SCORE_STREAM_SIGNALS}`);
  logger.info(`TP/SL %: ${TAKE_PROFIT}/${STOP_LOSS}`);
  logger.info(`Slippage buy/sell %: ${BUY_SLIPPAGE}/${SELL_SLIPPAGE}`);
  logger.info(`Tip SOL: ${TIP_SOL} | Priority µLamports: ${COMPUTE_UNIT_PRICE} | CU limit: ${COMPUTE_UNIT_LIMIT}`);
  logger.info(`One token at a time: ${ONE_TOKEN_AT_A_TIME}`);
  logger.info('-----------------------------');

  await discovery.start();

  const watcher = new StreamWatcher({
    rpcUrl: RPC_ENDPOINT,
    wsUrl: RPC_WEBSOCKET_ENDPOINT,
    presets: STREAM_PRESETS,
    onSignal: (signal) => {
      void bot.onSignal(signal);
    },
  });

  await watcher.start();
  logger.info(
    'Bot running. Discovery ranks coins to buy; streams are scored before entry. CTRL+C to stop.',
  );

  const shutdown = async () => {
    logger.info('Shutting down...');
    await discovery.stop();
    await watcher.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  logger.error(error, 'Fatal error');
  process.exit(1);
});
