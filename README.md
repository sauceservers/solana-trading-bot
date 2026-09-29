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
5. Run: `npm run start`

You should see Outsmart adapters register, stream presets start, then `New pool detected` / buy attempts as liquidity appears.

## Configuration

### Core

- `PRIVATE_KEY` — base58 / JSON array / mnemonic (see `helpers/wallet.ts`)
- `RPC_ENDPOINT` / `RPC_WEBSOCKET_ENDPOINT` — HTTP + WS RPC
- `MAINNET_ENDPOINT` — used by Outsmart (defaults to `RPC_ENDPOINT`)
- `ENABLED_DEXES` — comma-separated Outsmart adapter names
- `STREAM_PRESETS` — `new-pools`, `pumpswap`, `raydium`, `meteora`, `pumpfun-bonding`, …
- `AUTO_BUY` / `AUTO_SELL` — enable entries / exits
- `QUOTE_AMOUNT` — SOL to spend per buy
- `BUY_SLIPPAGE` / `SELL_SLIPPAGE` — percent (converted to bps for Outsmart)
- `TIP_SOL` — optional MEV tip for landing (default `0`)
- `ONE_TOKEN_AT_A_TIME` — serialize entries

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
