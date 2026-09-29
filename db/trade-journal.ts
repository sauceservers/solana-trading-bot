import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '../helpers/logger';
import { TradeSignal } from '../venues/types';

export type TradeMode = 'paper' | 'live';

export interface JournalFill {
  signalId?: number | null;
  positionId?: number | null;
  mode: TradeMode;
  dex: string;
  pool: string;
  mint: string;
  side: 'buy' | 'sell';
  status: 'confirmed' | 'failed' | 'skipped';
  amountInSol?: number | null;
  amountOutTokens?: number | null;
  amountOutSol?: number | null;
  priceSolPerToken?: number | null;
  signature?: string | null;
  pricing?: string | null;
  pnlSol?: number | null;
  pnlPct?: number | null;
  holdMs?: number | null;
  exitReason?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * SQLite trade journal for paper + live fills.
 * Uses Node's built-in `node:sqlite` (no native addon).
 */
export class TradeJournal {
  private readonly db: DatabaseSync;
  readonly dbPath: string;
  private runId: number | null = null;

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
    logger.info({ dbPath: this.dbPath }, 'Trade journal ready');
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS algo_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        mode TEXT NOT NULL,
        config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        ts INTEGER NOT NULL,
        dex TEXT NOT NULL,
        pool TEXT NOT NULL,
        mint TEXT,
        token_a TEXT,
        token_b TEXT,
        source TEXT NOT NULL,
        discovery_sig TEXT,
        accepted INTEGER NOT NULL DEFAULT 0,
        skip_reason TEXT,
        FOREIGN KEY(run_id) REFERENCES algo_runs(id)
      );

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        signal_id INTEGER,
        mode TEXT NOT NULL,
        dex TEXT NOT NULL,
        pool TEXT NOT NULL,
        mint TEXT NOT NULL,
        entry_sol REAL NOT NULL,
        token_amount REAL,
        opened_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        closed_at INTEGER,
        exit_sol REAL,
        pnl_sol REAL,
        pnl_pct REAL,
        exit_reason TEXT,
        pricing TEXT,
        FOREIGN KEY(run_id) REFERENCES algo_runs(id),
        FOREIGN KEY(signal_id) REFERENCES signals(id)
      );

      CREATE TABLE IF NOT EXISTS fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        signal_id INTEGER,
        position_id INTEGER,
        mode TEXT NOT NULL,
        dex TEXT NOT NULL,
        pool TEXT NOT NULL,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        status TEXT NOT NULL,
        amount_in_sol REAL,
        amount_out_tokens REAL,
        amount_out_sol REAL,
        price_sol_per_token REAL,
        signature TEXT,
        pricing TEXT,
        pnl_sol REAL,
        pnl_pct REAL,
        hold_ms INTEGER,
        exit_reason TEXT,
        meta_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES algo_runs(id),
        FOREIGN KEY(signal_id) REFERENCES signals(id),
        FOREIGN KEY(position_id) REFERENCES positions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_fills_created ON fills(created_at);
    `);
  }

  startRun(mode: TradeMode, config: Record<string, unknown>): number {
    const result = this.db
      .prepare('INSERT INTO algo_runs(started_at, mode, config_json) VALUES (?, ?, ?)')
      .run(Date.now(), mode, JSON.stringify(config));
    this.runId = Number(result.lastInsertRowid);
    logger.info({ runId: this.runId, mode }, 'Algo run started');
    return this.runId;
  }

  recordSignal(
    signal: TradeSignal,
    opts: { accepted: boolean; skipReason?: string },
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO signals(
          run_id, ts, dex, pool, mint, token_a, token_b, source, discovery_sig, accepted, skip_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.runId,
        signal.discoveredAt || Date.now(),
        signal.dex,
        signal.pool,
        signal.mint ?? null,
        signal.tokenA ?? null,
        signal.tokenB ?? null,
        signal.source,
        signal.signature ?? null,
        opts.accepted ? 1 : 0,
        opts.skipReason ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  openPosition(input: {
    signalId?: number | null;
    mode: TradeMode;
    dex: string;
    pool: string;
    mint: string;
    entrySol: number;
    tokenAmount?: number | null;
    pricing?: string | null;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO positions(
          run_id, signal_id, mode, dex, pool, mint, entry_sol, token_amount, opened_at, status, pricing
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        this.runId,
        input.signalId ?? null,
        input.mode,
        input.dex,
        input.pool,
        input.mint,
        input.entrySol,
        input.tokenAmount ?? null,
        Date.now(),
        input.pricing ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  closePosition(input: {
    positionId: number;
    exitSol: number;
    pnlSol: number;
    pnlPct: number;
    exitReason: string;
  }) {
    this.db
      .prepare(
        `UPDATE positions
         SET status='closed', closed_at=?, exit_sol=?, pnl_sol=?, pnl_pct=?, exit_reason=?
         WHERE id=?`,
      )
      .run(Date.now(), input.exitSol, input.pnlSol, input.pnlPct, input.exitReason, input.positionId);
  }

  recordFill(fill: JournalFill): number {
    const result = this.db
      .prepare(
        `INSERT INTO fills(
          run_id, signal_id, position_id, mode, dex, pool, mint, side, status,
          amount_in_sol, amount_out_tokens, amount_out_sol, price_sol_per_token,
          signature, pricing, pnl_sol, pnl_pct, hold_ms, exit_reason, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.runId,
        fill.signalId ?? null,
        fill.positionId ?? null,
        fill.mode,
        fill.dex,
        fill.pool,
        fill.mint,
        fill.side,
        fill.status,
        fill.amountInSol ?? null,
        fill.amountOutTokens ?? null,
        fill.amountOutSol ?? null,
        fill.priceSolPerToken ?? null,
        fill.signature ?? null,
        fill.pricing ?? null,
        fill.pnlSol ?? null,
        fill.pnlPct ?? null,
        fill.holdMs ?? null,
        fill.exitReason ?? null,
        fill.meta ? JSON.stringify(fill.meta) : null,
        Date.now(),
      );
    return Number(result.lastInsertRowid);
  }

  summary() {
    const open = this.db.prepare(`SELECT COUNT(*) AS c FROM positions WHERE status='open'`).get() as {
      c: number;
    };
    const closed = this.db
      .prepare(
        `SELECT COUNT(*) AS trades,
                COALESCE(SUM(pnl_sol),0) AS pnl_sol,
                COALESCE(AVG(pnl_pct),0) AS avg_pnl_pct,
                COALESCE(SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END),0) AS wins,
                COALESCE(SUM(CASE WHEN pnl_sol <= 0 THEN 1 ELSE 0 END),0) AS losses
         FROM positions WHERE status='closed'`,
      )
      .get() as {
      trades: number;
      pnl_sol: number;
      avg_pnl_pct: number;
      wins: number;
      losses: number;
    };
    const signals = this.db.prepare(`SELECT COUNT(*) AS c FROM signals`).get() as { c: number };
    return {
      signals: signals.c,
      openPositions: open.c,
      closedTrades: closed.trades,
      realizedPnlSol: closed.pnl_sol,
      avgPnlPct: closed.avg_pnl_pct,
      wins: closed.wins,
      losses: closed.losses,
      winRate: closed.trades > 0 ? closed.wins / closed.trades : 0,
    };
  }

  close() {
    this.db.close();
  }
}
