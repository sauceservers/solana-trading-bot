import { Logger } from 'pino';
import dotenv from 'dotenv';
import { Commitment } from '@solana/web3.js';
import { SubscriptionPreset } from 'outsmart';
import { logger } from './logger';
import { OutsmartDex } from '../venues/types';
import { SelectionProfileName } from '../discovery/types';

dotenv.config();

const discoveryOnly = process.env.DISCOVERY_ONLY === 'true';

const retrieveEnvVariable = (variableName: string, log: Logger, optional = false, fallback = '') => {
  const variable = process.env[variableName] || '';
  if (!variable && !optional) {
    log.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable || fallback;
};

const retrieveBool = (variableName: string, defaultValue: boolean) => {
  const raw = process.env[variableName];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return raw === 'true';
};

const retrieveNumber = (variableName: string, defaultValue: number) => {
  const raw = process.env[variableName];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
};

// Wallet — optional in DISCOVERY_ONLY explore mode
export const PRIVATE_KEY = discoveryOnly
  ? retrieveEnvVariable('PRIVATE_KEY', logger, true, '')
  : retrieveEnvVariable('PRIVATE_KEY', logger);

// Connection — also mirrored into Outsmart's MAINNET_ENDPOINT below
export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = (retrieveEnvVariable(
  'COMMITMENT_LEVEL',
  logger,
  true,
  'confirmed',
) || 'confirmed') as Commitment;
export const RPC_ENDPOINT = retrieveEnvVariable(
  'RPC_ENDPOINT',
  logger,
  true,
  'https://api.mainnet-beta.solana.com',
);
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable(
  'RPC_WEBSOCKET_ENDPOINT',
  logger,
  true,
  'wss://api.mainnet-beta.solana.com',
);

// Outsmart reads MAINNET_ENDPOINT / PRIVATE_KEY from process.env
if (PRIVATE_KEY) process.env.PRIVATE_KEY = PRIVATE_KEY;
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
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger, true, 'info');
export const ONE_TOKEN_AT_A_TIME = retrieveBool('ONE_TOKEN_AT_A_TIME', true);
export const AUTO_BUY = retrieveBool('AUTO_BUY', false);
export const COMPUTE_UNIT_LIMIT = retrieveNumber('COMPUTE_UNIT_LIMIT', 400000);
export const COMPUTE_UNIT_PRICE = retrieveNumber('COMPUTE_UNIT_PRICE', 421197);
export const TIP_SOL = Number(process.env.TIP_SOL || process.env.DEFAULT_TIP_SOL || '0');

// Reject legacy Warp executor if someone still has it in .env
const legacyExecutor = (process.env.TRANSACTION_EXECUTOR || '').toLowerCase();
if (legacyExecutor === 'warp') {
  logger.error('TRANSACTION_EXECUTOR=warp is removed. Outsmart handles TX landing (set TIP_SOL / TX_LANDING_MODE).');
  process.exit(1);
}

// Buy
export const AUTO_BUY_DELAY = retrieveNumber('AUTO_BUY_DELAY', 0);
export const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger, true, 'WSOL');
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger, true, '0.001');
export const MAX_BUY_RETRIES = retrieveNumber('MAX_BUY_RETRIES', 3);
export const BUY_SLIPPAGE = retrieveNumber('BUY_SLIPPAGE', 20);

// Sell
export const AUTO_SELL = retrieveBool('AUTO_SELL', false);
export const AUTO_SELL_DELAY = retrieveNumber('AUTO_SELL_DELAY', 0);
export const MAX_SELL_RETRIES = retrieveNumber('MAX_SELL_RETRIES', 3);
export const TAKE_PROFIT = retrieveNumber('TAKE_PROFIT', 40);
export const STOP_LOSS = retrieveNumber('STOP_LOSS', 20);
export const PRICE_CHECK_INTERVAL = retrieveNumber('PRICE_CHECK_INTERVAL', 2000);
export const PRICE_CHECK_DURATION = retrieveNumber('PRICE_CHECK_DURATION', 0);
export const SELL_SLIPPAGE = retrieveNumber('SELL_SLIPPAGE', 20);

// ---- Coin selection / discovery (what to buy) ----
export const DISCOVERY_ENABLED = retrieveBool('DISCOVERY_ENABLED', true);
/** explore = rank only; trade = discovery picks can buy when AUTO_BUY=true */
export const DISCOVERY_MODE = (process.env.DISCOVERY_MODE || 'explore').toLowerCase() === 'trade'
  ? 'trade'
  : 'explore';
export const SELECTION_PROFILE = (process.env.SELECTION_PROFILE || 'balanced').toLowerCase() as SelectionProfileName;
export const DISCOVERY_POLL_INTERVAL_MS = retrieveNumber('DISCOVERY_POLL_INTERVAL_MS', 45_000);
export const DISCOVERY_TOP_N = retrieveNumber('DISCOVERY_TOP_N', 15);
export const DISCOVERY_ENABLE_PUMP = retrieveBool('DISCOVERY_ENABLE_PUMP', true);
export const DISCOVERY_ENABLE_DEXSCREENER = retrieveBool('DISCOVERY_ENABLE_DEXSCREENER', true);
export const SCORE_STREAM_SIGNALS = retrieveBool('SCORE_STREAM_SIGNALS', true);

// Legacy Raydium-v4-only filters (still used when ENABLE_LEGACY_FILTERS=true)
export const ENABLE_LEGACY_FILTERS = retrieveBool('ENABLE_LEGACY_FILTERS', false);
export const FILTER_CHECK_INTERVAL = retrieveNumber('FILTER_CHECK_INTERVAL', 2000);
export const FILTER_CHECK_DURATION = retrieveNumber('FILTER_CHECK_DURATION', 60000);
export const CONSECUTIVE_FILTER_MATCHES = retrieveNumber('CONSECUTIVE_FILTER_MATCHES', 3);
export const CHECK_IF_MUTABLE = retrieveBool('CHECK_IF_MUTABLE', false);
export const CHECK_IF_SOCIALS = retrieveBool('CHECK_IF_SOCIALS', false);
export const CHECK_IF_MINT_IS_RENOUNCED = retrieveBool('CHECK_IF_MINT_IS_RENOUNCED', true);
export const CHECK_IF_FREEZABLE = retrieveBool('CHECK_IF_FREEZABLE', false);
export const CHECK_IF_BURNED = retrieveBool('CHECK_IF_BURNED', true);
export const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger, true, '0');
export const MAX_POOL_SIZE = retrieveEnvVariable('MAX_POOL_SIZE', logger, true, '0');
export const USE_SNIPE_LIST = retrieveBool('USE_SNIPE_LIST', false);
export const SNIPE_LIST_REFRESH_INTERVAL = retrieveNumber('SNIPE_LIST_REFRESH_INTERVAL', 30000);
