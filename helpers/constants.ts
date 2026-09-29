import { Logger } from 'pino';
import dotenv from 'dotenv';
import { Commitment } from '@solana/web3.js';
import type { SubscriptionPreset } from 'outsmart';
import { logger } from './logger';
import type { OutsmartDex } from '../venues/types';

dotenv.config();

const retrieveEnvVariable = (variableName: string, log: Logger, optional = false) => {
  const variable = process.env[variableName] || '';
  if (!variable && !optional) {
    log.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

const retrieveBool = (variableName: string, defaultValue: boolean) => {
  const raw = process.env[variableName];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return raw === 'true';
};

// Wallet
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);

// Connection — also mirrored into Outsmart's MAINNET_ENDPOINT below
export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

// Multi-key load spreading (optional). Prefer RPC_KEYS_FILE with one key/URL per line.
export const RPC_KEYS_FILE = (process.env.RPC_KEYS_FILE || '').trim();
export const RPC_PROXY_PORT = Number(process.env.RPC_PROXY_PORT || '18789');

// Paper trading + trade journal (SQLite via node:sqlite)
export const PAPER_TRADE = retrieveBool('PAPER_TRADE', false);
export const TRADE_DB_PATH = (process.env.TRADE_DB_PATH || './data/trades.sqlite').trim();

// Outsmart reads MAINNET_ENDPOINT / PRIVATE_KEY from process.env
process.env.PRIVATE_KEY = PRIVATE_KEY;
process.env.MAINNET_ENDPOINT = process.env.MAINNET_ENDPOINT || RPC_ENDPOINT;

// Multi-DEX (Outsmart adapter names). Comma-separated.
const DEFAULT_DEXES: OutsmartDex[] = [
  'pumpfun-amm',
  'raydium-cpmm',
  'raydium-amm-v4',
  'raydium-launchlab',
  'pumpfun',
  'meteora-damm-v2',
  'meteora-dbc',
  'jupiter-ultra',
];

export const ENABLED_DEXES: Set<OutsmartDex> = new Set(
  (process.env.ENABLED_DEXES || DEFAULT_DEXES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as OutsmartDex[],
);

// Prefer a focused set — public RPCs rate-limit if you open every preset at once.
const DEFAULT_PRESETS: SubscriptionPreset[] = ['new-pools', 'pumpswap', 'raydium'];
export const STREAM_PRESETS: SubscriptionPreset[] = (
  process.env.STREAM_PRESETS || DEFAULT_PRESETS.join(',')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as SubscriptionPreset[];

// Bot
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger);
export const ONE_TOKEN_AT_A_TIME = retrieveEnvVariable('ONE_TOKEN_AT_A_TIME', logger) === 'true';
export const AUTO_BUY = retrieveBool('AUTO_BUY', true);
export const COMPUTE_UNIT_LIMIT = Number(retrieveEnvVariable('COMPUTE_UNIT_LIMIT', logger));
export const COMPUTE_UNIT_PRICE = Number(retrieveEnvVariable('COMPUTE_UNIT_PRICE', logger));
export const TIP_SOL = Number(process.env.TIP_SOL || process.env.DEFAULT_TIP_SOL || '0');

// Reject legacy Warp executor if someone still has it in .env
const legacyExecutor = (process.env.TRANSACTION_EXECUTOR || '').toLowerCase();
if (legacyExecutor === 'warp') {
  logger.error('TRANSACTION_EXECUTOR=warp is removed. Outsmart handles TX landing (set TIP_SOL / TX_LANDING_MODE).');
  process.exit(1);
}

// Buy
export const AUTO_BUY_DELAY = Number(retrieveEnvVariable('AUTO_BUY_DELAY', logger));
export const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
export const MAX_BUY_RETRIES = Number(retrieveEnvVariable('MAX_BUY_RETRIES', logger));
export const BUY_SLIPPAGE = Number(retrieveEnvVariable('BUY_SLIPPAGE', logger));

// Sell
export const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
export const AUTO_SELL_DELAY = Number(retrieveEnvVariable('AUTO_SELL_DELAY', logger));
export const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
export const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
export const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger));
export const PRICE_CHECK_INTERVAL = Number(retrieveEnvVariable('PRICE_CHECK_INTERVAL', logger));
export const PRICE_CHECK_DURATION = Number(retrieveEnvVariable('PRICE_CHECK_DURATION', logger));
export const SELL_SLIPPAGE = Number(retrieveEnvVariable('SELL_SLIPPAGE', logger));

// Legacy Raydium-v4-only filters (still used when ENABLE_LEGACY_FILTERS=true)
export const ENABLE_LEGACY_FILTERS = retrieveBool('ENABLE_LEGACY_FILTERS', false);
export const FILTER_CHECK_INTERVAL = Number(retrieveEnvVariable('FILTER_CHECK_INTERVAL', logger));
export const FILTER_CHECK_DURATION = Number(retrieveEnvVariable('FILTER_CHECK_DURATION', logger));
export const CONSECUTIVE_FILTER_MATCHES = Number(retrieveEnvVariable('CONSECUTIVE_FILTER_MATCHES', logger));
export const CHECK_IF_MUTABLE = retrieveEnvVariable('CHECK_IF_MUTABLE', logger) === 'true';
export const CHECK_IF_SOCIALS = retrieveEnvVariable('CHECK_IF_SOCIALS', logger) === 'true';
export const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true';
export const CHECK_IF_FREEZABLE = retrieveEnvVariable('CHECK_IF_FREEZABLE', logger) === 'true';
export const CHECK_IF_BURNED = retrieveEnvVariable('CHECK_IF_BURNED', logger) === 'true';
export const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);
export const MAX_POOL_SIZE = retrieveEnvVariable('MAX_POOL_SIZE', logger);
export const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
export const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
