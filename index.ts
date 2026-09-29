import { version } from './package.json';
import {
  AUTO_BUY,
  AUTO_BUY_DELAY,
  AUTO_SELL,
  AUTO_SELL_DELAY,
  BUY_SLIPPAGE,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  ENABLED_DEXES,
  LOG_LEVEL,
  MAX_BUY_RETRIES,
  MAX_SELL_RETRIES,
  ONE_TOKEN_AT_A_TIME,
  PRICE_CHECK_DURATION,
  PRIVATE_KEY,
  QUOTE_AMOUNT,
  QUOTE_MINT,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  SELL_SLIPPAGE,
  STREAM_PRESETS,
  TIP_SOL,
  getWallet,
  logger,
} from './helpers';
import { Bot } from './bot';
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
  logger.info(`Outsmart multi-DEX bot starting (v${version})`);

  // Ensure wallet key parses before we open streams
  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteMint = resolveQuoteMint();
  const amountSol = Number(QUOTE_AMOUNT);

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
  });

  logger.info('------- CONFIGURATION -------');
  logger.info(`Wallet: ${wallet.publicKey.toString()}`);
  logger.info(`RPC: ${RPC_ENDPOINT}`);
  logger.info(`Quote: ${QUOTE_AMOUNT} ${QUOTE_MINT} (${quoteMint})`);
  logger.info(`Enabled DEX adapters: ${[...ENABLED_DEXES].join(', ')}`);
  logger.info(`Stream presets: ${STREAM_PRESETS.join(', ')}`);
  logger.info(`Auto buy: ${AUTO_BUY} | Auto sell: ${AUTO_SELL}`);
  logger.info(`Slippage buy/sell %: ${BUY_SLIPPAGE}/${SELL_SLIPPAGE}`);
  logger.info(`Tip SOL: ${TIP_SOL} | Priority µLamports: ${COMPUTE_UNIT_PRICE} | CU limit: ${COMPUTE_UNIT_LIMIT}`);
  logger.info(`One token at a time: ${ONE_TOKEN_AT_A_TIME}`);
  logger.info('-----------------------------');

  const watcher = new StreamWatcher({
    rpcUrl: RPC_ENDPOINT,
    wsUrl: RPC_WEBSOCKET_ENDPOINT,
    presets: STREAM_PRESETS,
    onSignal: (signal) => {
      void bot.onSignal(signal);
    },
  });

  await watcher.start();
  logger.info('Bot is running. Listening for new pools / migrations across enabled DEXes. CTRL+C to stop.');

  const shutdown = async () => {
    logger.info('Shutting down...');
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
