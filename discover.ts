/**
 * Explore mode: scan Pump.fun + DexScreener and rank which meme coins to buy
 * under a selection profile — no trades are sent.
 *
 *   SELECTION_PROFILE=graduate npm run discover
 *   SELECTION_PROFILE=momentum npm run discover
 */
import {
  DISCOVERY_ENABLE_DEXSCREENER,
  DISCOVERY_ENABLE_PUMP,
  DISCOVERY_POLL_INTERVAL_MS,
  DISCOVERY_TOP_N,
  LOG_LEVEL,
  SELECTION_PROFILE,
  logger,
} from './helpers';
import { exploreOnce, getSelectionProfile, SELECTION_PROFILES } from './discovery';

async function main() {
  logger.level = LOG_LEVEL;
  const profile = getSelectionProfile(SELECTION_PROFILE);

  logger.info('======= MEME COIN DISCOVERY (explore) =======');
  logger.info(`Profile: ${profile.name} — ${profile.description}`);
  logger.info(`Min score: ${profile.minScore}`);
  logger.info(`Gates: mcap $${profile.gates.minMarketCapUsd}–$${profile.gates.maxMarketCapUsd}, age ${profile.gates.minAgeMinutes}–${profile.gates.maxAgeMinutes}m`);
  logger.info(`Other profiles: ${Object.keys(SELECTION_PROFILES).join(', ')}`);
  logger.info('=============================================');

  const board = await exploreOnce({
    enabled: true,
    mode: 'explore',
    profile: profile.name,
    pollIntervalMs: DISCOVERY_POLL_INTERVAL_MS,
    topN: DISCOVERY_TOP_N,
    enablePump: DISCOVERY_ENABLE_PUMP,
    enableDexScreener: DISCOVERY_ENABLE_DEXSCREENER,
    scoreStreamSignals: true,
  });

  const picks = board.filter((r) => r.score.total >= profile.minScore);
  logger.info(`Done. ${picks.length}/${board.length} coins cleared the '${profile.name}' bar.`);
  if (!picks.length) {
    logger.info('Try another SELECTION_PROFILE or loosen gates in discovery/profiles.ts');
  }
}

main().catch((error) => {
  logger.error(error, 'Discovery explore failed');
  process.exit(1);
});
