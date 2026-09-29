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
  RPC_PROXY_PORT,
  RPC_WEBSOCKET_ENDPOINT,
  SELL_SLIPPAGE,
  STREAM_PRESETS,
  TIP_SOL,
  createRpcPoolFromEnv,
  getWallet,
  logger,
  startRpcProxy,
} from './helpers';
import { version } from './package.json';

function resolveQuoteMint(wsolMint: string): string {
  const q = QUOTE_MINT.toUpperCase();
  if (q === 'WSOL' || q === 'SOL') {
    return wsolMint;
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
  const amountSol = Number(QUOTE_AMOUNT);

  // Build pool + HTTP load-balancer BEFORE importing outsmart (it caches Connection at import).
  const rpcPool = createRpcPoolFromEnv();
  let httpRpcUrl = RPC_ENDPOINT;
  let proxyClose: (() => Promise<void>) | undefined;

  if (rpcPool.size > 1) {
    const proxy = await startRpcProxy(rpcPool, RPC_PROXY_PORT);
    httpRpcUrl = proxy.url;
    proxyClose = proxy.close;
    process.env.MAINNET_ENDPOINT = httpRpcUrl;
    logger.info(
      { poolSize: rpcPool.size, proxy: httpRpcUrl, streamPresets: STREAM_PRESETS.length },
      'RPC load spreading enabled (HTTP round-robin + per-preset WS keys)',
    );
  } else {
    process.env.MAINNET_ENDPOINT = process.env.MAINNET_ENDPOINT || RPC_ENDPOINT;
    logger.info({ endpoint: RPC_ENDPOINT }, 'Single RPC endpoint (set RPC_KEYS_FILE to spread load)');
  }

  // Dynamic imports so Outsmart binds MAINNET_ENDPOINT to the proxy URL
  const [{ WSOL_MINT }, { Bot }, { OutsmartTrader, StreamWatcher }] = await Promise.all([
    import('outsmart'),
    import('./bot'),
    import('./venues'),
  ]);

  const quoteMint = resolveQuoteMint(WSOL_MINT);

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
  logger.info(`RPC HTTP: ${httpRpcUrl} (pool=${rpcPool.size})`);
  logger.info(`RPC WS: sticky per stream preset across ${rpcPool.size} keys`);
  logger.info(`Quote: ${QUOTE_AMOUNT} ${QUOTE_MINT} (${quoteMint})`);
  logger.info(`Enabled DEX adapters: ${[...ENABLED_DEXES].join(', ')}`);
  logger.info(`Stream presets: ${STREAM_PRESETS.join(', ')}`);
  logger.info(`Auto buy: ${AUTO_BUY} | Auto sell: ${AUTO_SELL}`);
  logger.info(`Slippage buy/sell %: ${BUY_SLIPPAGE}/${SELL_SLIPPAGE}`);
  logger.info(`Tip SOL: ${TIP_SOL} | Priority µLamports: ${COMPUTE_UNIT_PRICE} | CU limit: ${COMPUTE_UNIT_LIMIT}`);
  logger.info(`One token at a time: ${ONE_TOKEN_AT_A_TIME}`);
  logger.info('-----------------------------');

  const watcher = new StreamWatcher({
    rpcUrl: httpRpcUrl,
    wsUrl: RPC_WEBSOCKET_ENDPOINT,
    rpcPool,
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
    if (proxyClose) {
      await proxyClose();
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  logger.error(error, 'Fatal error');
  process.exit(1);
});
