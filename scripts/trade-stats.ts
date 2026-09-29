/**
 * Print aggregate stats from the trade journal SQLite DB.
 * Usage: npx ts-node scripts/trade-stats.ts [path/to/trades.sqlite]
 */
import path from 'path';
import { TradeJournal } from '../db/trade-journal';
import { DatabaseSync } from 'node:sqlite';

const dbPath = path.resolve(process.argv[2] || process.env.TRADE_DB_PATH || './data/trades.sqlite');
const journal = new TradeJournal(dbPath);
const summary = journal.summary();
journal.close();

console.log('=== Trade journal ===');
console.log(`db: ${dbPath}`);
console.log(summary);

const db = new DatabaseSync(dbPath, { readOnly: true });
const recent = db
  .prepare(
    `SELECT id, mode, dex, side, status, amount_in_sol, amount_out_sol, pnl_sol, pnl_pct, exit_reason, pricing, created_at
     FROM fills ORDER BY id DESC LIMIT 15`,
  )
  .all();

console.log('\n=== Recent fills (15) ===');
for (const row of recent) {
  console.log(row);
}

const byDex = db
  .prepare(
    `SELECT dex,
            COUNT(*) AS closed,
            ROUND(COALESCE(SUM(pnl_sol),0), 6) AS pnl_sol,
            ROUND(COALESCE(AVG(pnl_pct),0), 2) AS avg_pnl_pct
     FROM positions WHERE status='closed'
     GROUP BY dex ORDER BY closed DESC`,
  )
  .all();

console.log('\n=== Closed PnL by DEX ===');
for (const row of byDex) {
  console.log(row);
}

const byExit = db
  .prepare(
    `SELECT exit_reason, COUNT(*) AS n, ROUND(COALESCE(AVG(pnl_pct),0), 2) AS avg_pnl_pct
     FROM positions WHERE status='closed'
     GROUP BY exit_reason ORDER BY n DESC`,
  )
  .all();

console.log('\n=== Exits by reason ===');
for (const row of byExit) {
  console.log(row);
}

db.close();
