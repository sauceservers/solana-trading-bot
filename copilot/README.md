# Trading Copilot

A side panel that sits next to Axiom / pump.fun / DexScreener / GMGN / Photon and answers the three questions that matter while a position is open:

1. **Rug or dip?** Is the red candle a deployer sell, an LP pull, a holder dump, a dead website, or just a dip. Verdict + evidence, refreshed every 30 s.
2. **Where is the stop?** Last real low minus one full median 1-minute range, so ordinary wicks cannot take it out. Exit ladder (principal out at 2x, half at 3x, trail), max position size for a 10% exit, and your own exit impact.
3. **What is the tape doing?** Market cap, liquidity, 5-minute buys/sells, tx/min, median 1-minute range, volume-divergence warning, 30 one-minute candles, and every trade over $2K with known bot wallets tagged.

Plus the full `token-check` report (flags + verdict) and a watchlist that fires Chrome notifications when a stop or target is crossed, or when a thesis-book 24-hour hands-off period ends.

Tokens under $500K market cap are classified **THESIS book**: no stop, no sell button for 24 h unless Rug-or-dip says RUG. Everything else is **MAIN book**: stops, ladders, and the chart decides.

## Layout

```
copilot/
  server/copilot_server.py   local HTTP server (stdlib only), port 8787
  server/data/watch.json     your watchlist (created on first use, git-ignored)
  extension/                 Chrome MV3 extension (side panel)
```

The server wraps `.cursor/skills/token-check/scripts/token_check.py` from this repo, so keep the repo checked out.

## Run

```bash
# 1. server (leave it running in a terminal)
python3 copilot/server/copilot_server.py
# -> copilot server on http://127.0.0.1:8787

# optional: faster/paid Solana RPC
SOL_RPC=https://your-rpc python3 copilot/server/copilot_server.py
```

```
# 2. extension
chrome://extensions  ->  Developer mode  ->  Load unpacked  ->  select copilot/extension
Pin "Trading Copilot". Click it to open the side panel.
```

Open any token page (pump.fun/coin/…, axiom.trade/meme/…, dexscreener.com/solana/…, gmgn, photon, birdeye, solscan, geckoterminal, bullx, padre, rugcheck). The panel detects the address from the URL, or from the page text if the site hides it, and loads. You can also paste a mint or pool address into the box.

## Endpoints (for scripts)

| Route | Returns |
|---|---|
| `GET /resolve?q=<mint or pool or 0x>` | `{address, chain}` |
| `GET /check?ca=&chain=` | token-check report, flags, verdict (cached 5 min) |
| `GET /live?ca=&chain=` | market, 30×1m candles in mcap terms, median range, vol trend, divergence, big trades |
| `GET /plan?ca=&chain=&entry=&size_sol=&sol_usd=` | book, last low, stop, ladder, max size, exit impact, notes |
| `GET /rug?ca=&chain=` | `RUG` / `WATCH` / `DIP`, score, action, evidence |
| `GET /watch` · `POST /watch` · `DELETE /watch?ca=` | watchlist with alerts |

## How Rug-or-dip scores

| Evidence | Points |
|---|---|
| deployer moved ≥1% of supply out in the last 30 min | 4 |
| mint or freeze authority still set | 3 each |
| liquidity down >40% since first seen | 3 |
| top-10 holders down ≥8 pts or 3+ of them dumped >50% | 3 |
| Token-2022 permanentDelegate / transferHook / pausable | 2 each |
| insider networks ≥15% | 2 |
| LP <50% locked, website unreachable, small deployer movement | 1 each |

Score ≥4 → **RUG** (sell now). 2–3 → **WATCH** (re-run in 2 min, do not add). Otherwise **DIP**.

Holder and liquidity deltas compare against the first snapshot the server took for that token, so open the panel when you enter, not when you panic. EVM tokens use the token-check contract flags only (no live deployer-wallet read yet).

## Limits

- Public Solana RPC is rate-limited; the deployer check reads at most 12 recent transactions. Set `SOL_RPC` for a paid endpoint if you trade a lot of fresh launches.
- GeckoTerminal indexes pump.fun curve tokens only after they have a pool; brand-new curve tokens resolve but show no candles.
- DexScreener's market cap can differ from Axiom's by a few percent on fresh tokens. Stops are computed in that basis.
- Not financial advice. The panel enforces rules you already agreed to; it does not pick winners.
