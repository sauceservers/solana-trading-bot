# Solana Multi-DEX Meme Trading Bot

Automated Solana trading bot built on **[Outsmart](https://github.com/outsmartchad/outsmart-cli)** DEX adapters.

The hard problem for meme coins is not only entry/exit — it is **which coins to buy**. This bot adds a **discovery + selection** layer that ranks live Pump.fun and DexScreener candidates under named profiles before any trade is sent.

## What to buy (discovery)

```bash
npm run discover                 # balanced profile
npm run discover:graduate        # near Pump graduation
npm run discover:momentum        # volume + buy pressure
npm run discover:social          # socials + early narrative
npm run discover:scalp           # hot m5 flow
npm run discover:early           # low mcap pre-crowd (higher risk)
```

No wallet needed for explore. Each run pulls candidates and prints a ranked board (`PICK` vs `watch`) with score, mcap, bonding %, and reasons.

| Profile | Edge it hunts |
| --- | --- |
| `balanced` | Mid-cap + liquidity + ≥1 social |
| `graduate` | Pump bonding ~55–99% before migration |
| `momentum` | Strong buy/sell ratio + volume velocity |
| `social` | Twitter/TG/site + replies, early mcap |
| `scalp` | Fresh boosts / m5 volume spikes |
| `early` | Low mcap bonding with socials |

Tune gates/weights in `discovery/profiles.ts`. Env:

- `SELECTION_PROFILE` — which profile
- `DISCOVERY_MODE=explore|trade` — rank only vs allow buys from picks
- `SCORE_STREAM_SIGNALS=true` — also filter websocket new-pools through the same scorer
- `AUTO_BUY=true` + `DISCOVERY_MODE=trade` — actually buy selected coins

## Supported markets (via Outsmart)

| Adapter | Protocol |
| --- | --- |
| `pumpfun-amm` | PumpSwap AMM (migrated Pump tokens) |
| `pumpfun` | Pump.fun bonding curve |
| `raydium-amm-v4` / `raydium-cpmm` / `raydium-clmm` / `raydium-launchlab` | Raydium |
| `meteora-*` | Meteora |
| `jupiter-ultra`, `dflow` | Aggregators (sell fallback) |

**Warp execution / tipping is removed.** Tips are optional (`TIP_SOL`).

## Setup

1. Create a funded Solana wallet (only needed for live trading).
2. Copy `.env.copy` → `.env`.
3. Install: `npm install --legacy-peer-deps`
4. Explore picks: `npm run discover`
5. Typecheck: `npm run tsc`
6. Trade (after picks look sane): set `PRIVATE_KEY`, `AUTO_BUY=true`, `DISCOVERY_MODE=trade`, then `npm run start`

## Architecture

```
Pump.fun API ─┐
DexScreener  ─┼─► DiscoveryPipeline ─► score/rank ─► PICK board
Outsmart WS  ─┘         │
                        ▼ (DISCOVERY_MODE=trade + AUTO_BUY)
                   Bot.onDiscoveryPick / scored stream
                        ▼
                   OutsmartTrader buy/sell
```

## Security notes

- Never commit `.env`.
- Do not re-enable Warp.
- Trading memes is high risk. Start with `DISCOVERY_MODE=explore`, tiny `QUOTE_AMOUNT`, and `AUTO_BUY=false`.

## Disclaimer

Provided as-is for learning and research. You are solely responsible for funds and compliance. Past-looking scores do not guarantee profit.
