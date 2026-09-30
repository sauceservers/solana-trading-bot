---
name: token-check
description: "One-command due diligence on a memecoin address (Solana or EVM: Robinhood Chain, BSC, Ethereum, Base, Arbitrum). Run scripts/token_check.py to get market data, contract authorities, holder concentration, launch sniper analysis, bot/bundler detection, candle-range analysis and a flagged verdict in one compact report. Use whenever the user pastes a token address and asks if it is a scam, worth buying, or what the price action means."
---

# Token Check

Run one script, read one report, answer. Do not hand-roll RPC calls, DexScreener fetches, or holder rebuilds when this skill applies — the script already does all of it in 2–10 seconds and prints ~60 lines.

## When to use

- User pastes a contract/mint address and asks any of: "analyze this", "is this a scam", "worth investing", "will it moon", "does the price action look normal".
- User asks to compare several tokens (run once per address).
- User asks to screen candidates you found elsewhere (run on each finalist).

## How to run

```bash
python3 .cursor/skills/token-check/scripts/token_check.py <address>
```

Options:

| Flag | Use when |
|---|---|
| `--full` | You need the longer holder / trader / candle tables (e.g. user asks "who are the top holders" or "show me the candles"). |
| `--no-chain` | Fast mode: skip RPC log rebuild. Use for tokens older than a few days on slow chains (Ethereum) where the Transfer window would be huge anyway. |
| `--chain <id>` | Auto-detect failed (no DexScreener pairs). Ids: `solana`, `robinhood`, `bsc`, `ethereum`, `base`, `arbitrum`. |
| `--json` | Appends a machine-readable summary line; use if you will post-process several tokens. |

Address type is auto-detected: `0x` + 40 hex = EVM, otherwise Solana base58. Chain is taken from DexScreener's top pool.

## Reading the report

Sections in order — each is self-contained and you can quote from them directly:

| Section | What it answers |
|---|---|
| `MARKET` | Price, cap, liquidity (and % of cap), age, volume/liquidity ratio, tx/min, socials. `vol24/liq` > 30x and > 100 tx/min on < $500K liquidity mean bot volume. |
| `CONTRACT` | Solana: program (SPL vs Token-2022), mint/freeze authority, transfer fee, dangerous extensions, launchpad, creator balance. EVM: owner, proxy, control selectors present in bytecode, live tax/limit state, GoPlus flags where supported. "control selectors: none" + "owner none" = token itself cannot rug. |
| `HOLDERS` | Top-10 %, largest EOA, burn %, insider networks (Solana), EIP-7702 smart-wallet clusters (EVM). A non-pool contract holding > 5% is a locker/hook/treasury — say who controls it if the user cares. |
| `LIQUIDITY` (Solana) | Per-pool locked %. < 50% locked is a yellow flag. |
| `LAUNCH` (EVM) | Who received tokens in the first 60 s and what they still hold. "took X%, still hold ~0%" = snipers distributed into current holders. Contract buyers that dumped are sniper bots. |
| `ACTIVITY` (EVM) | Last ~6 min of swaps: unique traders, round-trippers, top-10 tx share, wallets tagged `FEE-HOOK/SKIMMER` or `VOLUME-BOT`, identical-size buyer clusters (bundlers). |
| `CANDLES` | Median intra-minute range from the top pool. ≥ 25% median = pure bot churn; ≤ 10% = a real market. Also 7-day path and drawdown from ATH. |
| `FLAGS` / `VERDICT` | Consolidated RED / YELLOW / INFO list and one-line verdict. |

## How to answer

1. Lead with the verdict and the two or three flags that matter most for the user's question.
2. Translate numbers into consequences: "$56K liquidity means a $5K sell moves price double digits", "snipers took 39% and hold 0% means everyone now holding bought from the bot".
3. Distinguish contract risk (can they take my money) from market risk (will it go to zero). A clean contract with terrible market structure is the common case; say so explicitly.
4. For "does the price action look normal": quote the median 1-minute range, tx/min vs liquidity, the round-tripper count and any `VOLUME-BOT` / `FEE-HOOK` / bundler lines. Organic markets do not have 30%+ ranges every minute.
5. Do not add speculative narrative research (X search, website fetch) unless the user asks or the verdict is clean and the narrative is what decides. If you do, one `WebFetch` on the listed website and one X lookup of the listed handle is enough.
6. End with a one-line sizing statement and "not financial advice". No emojis.

## Known limits

- GoPlus has no Robinhood Chain coverage; the RPC analysis covers it instead.
- EVM holder rebuild reads Transfer logs back to launch (capped at ~400K blocks on fast chains, ~60K on slow ones). If the mint is not in the window the report says "balances partial".
- Free BSC RPCs only serve the last ~2h of logs. The script detects this, prints a `HOLDERS (goplus snapshot)` block for full-supply concentration, and skips `LAUNCH`. Treat the rebuilt `HOLDERS` list on BSC as "recent movers", not the cap table.
- Solana trader-level activity is not rebuilt (public RPC rate limits); RugCheck insider networks and DexScreener tx rates stand in for it.
- Public RPCs can rate-limit; the script retries and rotates endpoints. A rerun usually clears a transient failure.
- Everything is a point-in-time snapshot; memes reprice in minutes. Always include the timestamp printed on the first line.
