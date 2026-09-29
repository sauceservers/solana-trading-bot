# Solana Multi-DEX Trading Bot

Automated Solana trading bot built on **[Outsmart](https://github.com/outsmartchad/outsmart-cli)** DEX adapters. It streams new pools / migrations and can buy & sell across major venues — not just legacy Raydium AMM v4.

## Supported markets (via Outsmart)

| Adapter | Protocol |
| --- | --- |
| `pumpfun-amm` | PumpSwap AMM (migrated Pump tokens) |
| `pumpfun` | Pump.fun bonding curve |
| `raydium-amm-v4` | Raydium AMM v4 |
| `raydium-cpmm` | Raydium CPMM |
| `raydium-clmm` | Raydium CLMM |
| `raydium-launchlab` | Raydium LaunchLab (e.g. Stonk-style launches) |
| `meteora-damm-v1` / `meteora-damm-v2` / `meteora-dlmm` / `meteora-dbc` | Meteora |
| `orca`, `byreal-clmm`, `pancakeswap-clmm`, `fusion-amm`, `futarchy-amm` | Other AMMs |
| `jupiter-ultra`, `dflow` | Aggregators (good sell fallback) |

**Warp execution / tipping is removed.** Tips are optional and explicit (`TIP_SOL`).

## Setup

1. Create a funded Solana wallet (and wrap SOL → WSOL if you buy with WSOL quote paths that need it).
2. Copy `.env.copy` → `.env` and fill `PRIVATE_KEY`, RPC URLs.
3. Install: `npm install --legacy-peer-deps`
4. Typecheck: `npm run tsc`
5. Paper trade (recommended first): `npm run paper`
6. Live: `npm run start`
7. Stats from the journal: `npm run stats`

You should see Outsmart adapters register, stream presets start, then `New pool detected` / buy attempts as liquidity appears.

## Configuration

### Core

- `PRIVATE_KEY` — base58 / JSON array / mnemonic (see `helpers/wallet.ts`)
- `RPC_ENDPOINT` / `RPC_WEBSOCKET_ENDPOINT` — HTTP + WS RPC (fallback / single-key mode)
- `MAINNET_ENDPOINT` — used by Outsmart (defaults to `RPC_ENDPOINT`; overridden by local proxy when pooling)
- `RPC_KEYS_FILE` — gitignored file (e.g. `rpc-keys.local.txt`) with one Helius API key or HTTPS URL per line. With 2+ keys the bot spreads HTTP via a local round-robin proxy and assigns each stream preset its own WS key.
- `RPC_PROXY_PORT` — local load-balancer port (default `18789`)
- `ENABLED_DEXES` — comma-separated Outsmart adapter names
- `STREAM_PRESETS` — `new-pools`, `pumpswap`, `raydium`, `meteora`, `pumpfun-bonding`, …
- `AUTO_BUY` / `AUTO_SELL` — enable entries / exits
- `QUOTE_AMOUNT` — SOL to spend per buy
- `BUY_SLIPPAGE` / `SELL_SLIPPAGE` — percent (converted to bps for Outsmart)
- `TIP_SOL` — optional MEV tip for landing (default `0`)
- `ONE_TOKEN_AT_A_TIME` — serialize entries
- `PAPER_TRADE` — `true` simulates fills (no chain txs); still streams live pools
- `TRADE_DB_PATH` — SQLite journal path (default `./data/trades.sqlite`)
- `TAKE_PROFIT` / `STOP_LOSS` — percent exits while holding (`AUTO_SELL=true`)
- `PRICE_CHECK_DURATION` — max hold ms; `PRICE_CHECK_INTERVAL` — mark poll ms

### Paper trading + trade DB

With `PAPER_TRADE=true` the bot:

1. Still listens to live `NewPool` / `BondingComplete` streams
2. Simulates buys/sells (Jupiter quote when a route exists, else tagged `synthetic`)
3. Writes every signal, fill, open/closed position, and PnL into SQLite
4. Exits on take-profit, stop-loss, or max hold

Use `npm run stats` to inspect win rate, PnL by DEX, and exit reasons — the dataset for improving the algo. Live mode (`PAPER_TRADE=false`) records the same tables with `mode=live`.

### Streams → buys

The bot starts parallel Outsmart `WsEventStream` presets. On `NewPool` or `BondingComplete` it maps the stream DEX label to an adapter (e.g. stream `pumpswap` → `pumpfun-amm`) and calls `adapter.buy({ poolAddress, amountSol })`.

For migrated Pump coins, prefer **`pumpfun-amm`**. For modern Raydium liquidity prefer **`raydium-cpmm`** / **`raydium-launchlab`**. Legacy OpenBook pools still work via **`raydium-amm-v4`**.

## Programmatic shape

```ts
import { getDexAdapter, registerAllAdapters } from 'outsmart';

await registerAllAdapters();
await getDexAdapter('pumpfun-amm').buy({ poolAddress, amountSol: 0.1 });
await getDexAdapter('raydium-cpmm').buy({ poolAddress, amountSol: 0.1 });
```

## Security notes

- Never commit `.env`.
- Do not re-enable Warp; it sent signed txs + tips to a third-party fee wallet.
- Outsmart tips are opt-in via `TIP_SOL` / Outsmart landing env vars.
- Trading is risky. Start with tiny `QUOTE_AMOUNT` and `AUTO_SELL=false` until you trust the path.

## Disclaimer

Provided as-is for learning and research. You are solely responsible for funds and compliance.
