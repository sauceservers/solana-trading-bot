#!/usr/bin/env python3
"""
Trading copilot local server.

Sits on localhost and feeds the Chrome side panel. Wraps the token-check skill
and adds the three things that matter while a position is open:

  /rug    RUG-or-DIP: is the red candle a dev/LP event or just a dip
  /plan   stop + exit ladder sized to the token's actual 1-minute volatility
  /live   fast tape: mcap, liq, buys/sells, volume trend, big trades, bot tags
  /watch  watchlist with stop/target alerts and thesis-book hands-off timers

Run:  python3 copilot/server/copilot_server.py  (port 8787)
Only stdlib. Public RPC / DexScreener / GeckoTerminal / RugCheck, no keys.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
TOKEN_CHECK = os.path.join(REPO, ".cursor", "skills", "token-check", "scripts", "token_check.py")
DATA_DIR = os.path.join(HERE, "data")
WATCH_FILE = os.path.join(DATA_DIR, "watch.json")
PORT = int(os.environ.get("COPILOT_PORT", "8787"))
SOL_RPC = os.environ.get("SOL_RPC", "https://api.mainnet-beta.solana.com")
UA = {"User-Agent": "Mozilla/5.0 (copilot)"}

# Wallets that show up on every bot-infested chart. Prefix match is enough for tagging.
KNOWN_BOTS = {
    "AgmLJBMD": "arb/MM bot",
    "2tgUbS9U": "volume bot",
    "FHpcNSe6": "bump bot",
    "BHREKFkP": "launch sniper",
}

_cache = {}
_cache_lock = threading.Lock()
_inflight = {}  # key -> lock, so concurrent panel requests share one slow computation
_baseline = {}  # ca -> first-seen snapshot used by /rug to detect LP pulls and holder dumps


def cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
        lock = _inflight.setdefault(key, threading.Lock())
    with lock:
        with _cache_lock:
            hit = _cache.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
        val = fn()
        with _cache_lock:
            _cache[key] = (time.time(), val)
        return val


def http_json(url, data=None, headers=None, timeout=20, retries=3):
    h = dict(UA)
    if headers:
        h.update(headers)
    body = json.dumps(data).encode() if data is not None else None
    if body is not None:
        h["Content-Type"] = "application/json"
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = {"__error__": f"HTTP {e.code}"}
            if e.code == 429:
                time.sleep(1.5 * (i + 1))
                continue
            return last
        except Exception as e:  # noqa: BLE001
            last = {"__error__": str(e)}
            time.sleep(0.5 * (i + 1))
    return last or {"__error__": "unknown"}


def rpc(method, params):
    r = http_json(SOL_RPC, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    return (r or {}).get("result")


# --------------------------------------------------------------------------- #
# Address resolution
# --------------------------------------------------------------------------- #

B58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
EVM = re.compile(r"^0x[0-9a-fA-F]{40}$")


def resolve(q):
    """Turn whatever the page gave us (mint, pair/pool address, EVM address) into a token address."""
    q = q.strip()
    if EVM.match(q):
        d = http_json(f"https://api.dexscreener.com/latest/dex/tokens/{q}")
        if (d or {}).get("pairs"):
            return {"address": q.lower(), "chain": d["pairs"][0]["chainId"], "kind": "token"}
        for chain in ("robinhood", "bsc", "base", "ethereum", "arbitrum"):
            d = http_json(f"https://api.dexscreener.com/latest/dex/pairs/{chain}/{q}")
            p = ((d or {}).get("pairs") or [None])[0] or (d or {}).get("pair")
            if p:
                return {"address": p["baseToken"]["address"].lower(), "chain": chain, "kind": "pair"}
        return {"error": "not indexed"}
    if not B58.match(q):
        return {"error": "not an address"}
    d = http_json(f"https://api.dexscreener.com/latest/dex/tokens/{q}")
    if (d or {}).get("pairs"):
        return {"address": q, "chain": d["pairs"][0]["chainId"], "kind": "token"}
    d = http_json(f"https://api.dexscreener.com/latest/dex/pairs/solana/{q}")
    p = ((d or {}).get("pairs") or [None])[0] or (d or {}).get("pair")
    if p:
        return {"address": p["baseToken"]["address"], "chain": "solana", "kind": "pair"}
    # Brand-new pump.fun curve tokens are not on DexScreener yet; confirm it is at least a mint.
    acct = rpc("getAccountInfo", [q, {"encoding": "jsonParsed"}])
    info = (((acct or {}).get("value") or {}).get("data") or {}).get("parsed", {})
    if info.get("type") == "mint":
        return {"address": q, "chain": "solana", "kind": "token", "unindexed": True}
    return {"error": "not indexed"}


# --------------------------------------------------------------------------- #
# Market snapshot (DexScreener + GeckoTerminal)
# --------------------------------------------------------------------------- #

GT_NET = {"solana": "solana", "bsc": "bsc", "base": "base", "ethereum": "eth", "arbitrum": "arbitrum", "robinhood": "robinhood"}


def pairs_for(ca, chain):
    d = http_json(f"https://api.dexscreener.com/token-pairs/v1/{chain}/{ca}")
    if not isinstance(d, list):
        return []
    return sorted(d, key=lambda x: -(((x.get("liquidity") or {}).get("usd")) or 0))


def market_snapshot(ca, chain):
    ps = pairs_for(ca, chain)
    if not ps:
        return None
    top = ps[0]
    price = float(top.get("priceUsd") or 0)
    liq = sum(((p.get("liquidity") or {}).get("usd") or 0) for p in ps)
    mcap = top.get("marketCap") or top.get("fdv") or 0
    fdv = top.get("fdv") or mcap
    # Circulating supply so candle prices convert to the same market cap the trader sees on screen.
    supply = (mcap / price) if price else 0
    # Volume and tx counts are summed across every pool; a token with a Meteora side pool still
    # does most of its trading on the pump AMM and the panel should reflect the whole tape.
    windows = ("m5", "h1", "h6", "h24")
    vol = {k: sum(((p.get("volume") or {}).get(k) or 0) for p in ps) for k in windows}
    tx = {k: (sum(((p.get("txns") or {}).get(k) or {}).get("buys", 0) for p in ps),
              sum(((p.get("txns") or {}).get(k) or {}).get("sells", 0) for p in ps)) for k in windows}
    created = min((p.get("pairCreatedAt") for p in ps if p.get("pairCreatedAt")), default=None)
    return {
        "name": top["baseToken"]["name"], "symbol": top["baseToken"]["symbol"], "chain": chain,
        "dex": top.get("dexId"), "pair": top["pairAddress"], "price": price, "mcap": mcap, "fdv": fdv,
        "supply": supply, "liq": liq, "liq_top": (top.get("liquidity") or {}).get("usd") or 0,
        "chg": top.get("priceChange") or {}, "vol": vol, "tx": tx,
        "created_ms": created,
        "age_h": (time.time() * 1000 - created) / 3.6e6 if created else None,
        "websites": [w["url"] for w in (top.get("info") or {}).get("websites", [])],
        "socials": [s["url"] for s in (top.get("info") or {}).get("socials", [])],
        "pools": len(ps),
    }


def candles_1m(pair, chain, limit=60):
    net = GT_NET.get(chain, chain)
    d = http_json(f"https://api.geckoterminal.com/api/v2/networks/{net}/pools/{pair}/ohlcv/minute?aggregate=1&limit={limit}&currency=usd")
    ol = (((d or {}).get("data") or {}).get("attributes") or {}).get("ohlcv_list") or []
    return sorted(ol)


def trades(pair, chain, min_usd=0):
    net = GT_NET.get(chain, chain)
    url = f"https://api.geckoterminal.com/api/v2/networks/{net}/pools/{pair}/trades"
    if min_usd:
        url += f"?trade_volume_in_usd_greater_than={min_usd}"
    d = http_json(url)
    return [x["attributes"] for x in ((d or {}).get("data") or [])]


# --------------------------------------------------------------------------- #
# /check  (token-check skill, cached 5 min)
# --------------------------------------------------------------------------- #

def run_check(ca, chain):
    def go():
        args = [sys.executable, TOKEN_CHECK, ca, "--json", "--full"]
        if chain and chain != "solana":
            args += ["--chain", chain]
        try:
            out = subprocess.run(args, capture_output=True, text=True, timeout=240).stdout
        except subprocess.TimeoutExpired as e:
            out = (e.stdout or "") + "\n# token_check timed out"
        lines = out.strip().splitlines()
        summary = {}
        for ln in reversed(lines):
            if ln.startswith("{"):
                try:
                    summary = json.loads(ln)
                except json.JSONDecodeError:
                    pass
                break
        report = "\n".join(ln for ln in lines if not ln.startswith("{"))
        return {"report": report, "verdict": summary.get("verdict"), "flags": summary.get("flags", []),
                "market": summary.get("market"), "ts": time.time()}
    return cached(("check", ca), 300, go)


# --------------------------------------------------------------------------- #
# /live
# --------------------------------------------------------------------------- #

def live(ca, chain):
    m = market_snapshot(ca, chain)
    if not m:
        return {"error": "no pairs"}
    ol = candles_1m(m["pair"], chain, 30)
    sup = m["supply"]
    vols = [v for *_, v in ol[-10:]]
    cs = [{"t": t, "o": o * sup, "h": h * sup, "l": l * sup, "c": c * sup, "v": v} for t, o, h, l, c, v in ol[-30:]]
    rng = sorted(100 * (h / l - 1) for _, o, h, l, c, v in ol if l > 0)
    med_range = rng[len(rng) // 2] if rng else None
    # Volume divergence: price at/near a 10-minute high while volume is < half the recent peak.
    div = None
    if len(ol) >= 12:
        last = ol[-2]  # last completed candle; the forming one has partial volume
        hi10 = max(x[2] for x in ol[-11:-1])
        peak_v = max(x[5] for x in ol[-11:-2])
        if last[2] >= hi10 * 0.98 and peak_v and last[5] < 0.5 * peak_v:
            div = f"new high on {100*last[5]/peak_v:.0f}% of peak volume"
    big = []
    for a in trades(m["pair"], chain, 2000)[:25]:
        w = a.get("tx_from_address") or ""
        tag = next((v for k, v in KNOWN_BOTS.items() if w.startswith(k)), None)
        big.append({"t": a["block_timestamp"][11:19], "kind": a["kind"], "usd": round(float(a["volume_in_usd"])),
                    "wallet": w[:8], "bot": tag})
    tx5 = m["tx"].get("m5", (0, 0))
    return {"market": m, "candles": cs, "median_range_pct": med_range, "vol_trend": vols,
            "divergence": div, "big_trades": big, "buys5": tx5[0], "sells5": tx5[1],
            "tx_per_min": (tx5[0] + tx5[1]) / 5, "ts": time.time()}


# --------------------------------------------------------------------------- #
# /plan
# --------------------------------------------------------------------------- #

def plan(ca, chain, entry_mcap=None, size_sol=None, sol_usd=None):
    m = market_snapshot(ca, chain)
    if not m:
        return {"error": "no pairs"}
    ol = candles_1m(m["pair"], chain, 60)
    sup = m["supply"]
    mcap = m["mcap"] or 0
    if not ol:
        return {"error": "no candles", "market": m}
    rng = sorted(100 * (h / l - 1) for _, o, h, l, c, v in ol if l > 0)
    med = rng[len(rng) // 2] if rng else 15.0
    # "Last real low": the lowest low since the most recent 1m high, ignoring the still-forming candle.
    done = ol[:-1] if len(ol) > 1 else ol
    hi_i = max(range(len(done)), key=lambda i: done[i][2])
    after = done[hi_i:] or done
    last_low = min(x[3] for x in after[-8:]) * sup
    recent_high = done[hi_i][2] * sup
    # Stop sits a full median range below the last real low so ordinary wicks cannot take it out.
    stop = last_low * (1 - min(med, 40) / 100)
    book = "THESIS" if mcap and mcap < 500_000 else "MAIN"
    entry = entry_mcap or mcap
    ladder = [
        {"label": "principal out (sell enough to cover entry)", "mcap": entry * 2},
        {"label": "half of remainder at first lower high, or here", "mcap": entry * 3},
        {"label": "trail: move stop to last 1m low each leg", "mcap": entry * 5},
    ]
    liq = m["liq_top"] or m["liq"] or 1
    # Constant-product approximation: a sell of X into a pool with quote depth ~liq/2 moves price ~2X/liq.
    max_size_usd_10pct = liq * 0.05
    impact = None
    if size_sol and sol_usd:
        impact = 200 * (size_sol * sol_usd) / liq
    hands_off_until = None
    if book == "THESIS":
        hands_off_until = time.time() + 24 * 3600
    notes = []
    if med >= 25:
        notes.append(f"median 1m range {med:.0f}%: this is bot churn, stop needs to be wide or it will be wicked")
    if liq < 150_000:
        notes.append(f"liquidity ${liq:,.0f}: anything over ${max_size_usd_10pct:,.0f} costs >10% to exit")
    if m["age_h"] is not None and m["age_h"] < 1:
        notes.append(f"{m['age_h']*60:.0f} minutes old: no base exists yet, this is a lottery not a setup")
    if book == "THESIS":
        notes.append("under $500K: thesis book rules. No sell button for 24h unless /rug says RUG.")
    return {"market": m, "book": book, "median_range_pct": med, "last_low_mcap": last_low, "recent_high_mcap": recent_high,
            "stop_mcap": stop, "stop_pct_below": 100 * (1 - stop / mcap) if mcap else None, "entry_mcap": entry,
            "ladder": ladder, "max_size_usd_for_10pct_impact": max_size_usd_10pct, "exit_impact_pct": impact,
            "hands_off_until": hands_off_until, "notes": notes, "ts": time.time()}


# --------------------------------------------------------------------------- #
# /rug  RUG or DIP
# --------------------------------------------------------------------------- #

def deployer_recent_sells(creator, mint, minutes=30):
    """Did the deployer (or the wallet RugCheck calls creator) move this mint out in the last N minutes."""
    if not creator:
        return {"checked": False}
    sigs = rpc("getSignaturesForAddress", [creator, {"limit": 40}]) or []
    cutoff = time.time() - minutes * 60
    recent = [s for s in sigs if (s.get("blockTime") or 0) >= cutoff]
    moved = 0.0
    examined = 0
    for s in recent[:12]:
        tx = rpc("getTransaction", [s["signature"], {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
        if not tx:
            continue
        examined += 1
        meta = tx.get("meta") or {}
        pre = {b["accountIndex"]: b for b in meta.get("preTokenBalances", []) if b.get("mint") == mint and b.get("owner") == creator}
        post = {b["accountIndex"]: b for b in meta.get("postTokenBalances", []) if b.get("mint") == mint and b.get("owner") == creator}
        for idx, b in pre.items():
            before = float(b["uiTokenAmount"].get("uiAmount") or 0)
            after = float(post.get(idx, {}).get("uiTokenAmount", {}).get("uiAmount") or 0)
            if after < before:
                moved += before - after
    return {"checked": True, "recent_txs": len(recent), "examined": examined, "tokens_out": moved}


def rug_or_dip(ca, chain):
    if chain != "solana":
        chk = run_check(ca, chain)
        reds = [f for l, f in chk.get("flags", []) if l == "RED"]
        return {"verdict": "RUG" if reds else "DIP", "evidence": [{"level": "RED", "text": f} for f in reds] or
                [{"level": "OK", "text": "no contract-level red flags from token-check; EVM live dev-wallet check not implemented"}],
                "ts": time.time()}
    r = http_json(f"https://api.rugcheck.xyz/v1/tokens/{ca}/report")
    m = market_snapshot(ca, chain)
    ev = []
    score = 0
    if "token" in (r or {}):
        tok = r["token"]
        dec = tok["decimals"]
        supply = tok["supply"] / 10 ** dec
        ma, fa = r.get("mintAuthority"), r.get("freezeAuthority")
        if ma:
            ev.append({"level": "RED", "text": "mint authority still set (can print supply)"}); score += 3
        if fa:
            ev.append({"level": "RED", "text": "freeze authority still set (can freeze your wallet)"}); score += 3
        ext = r.get("token_extensions") or {}
        if isinstance(ext, dict):
            for k in ("permanentDelegate", "transferHook", "pausableConfig"):
                if ext.get(k):
                    ev.append({"level": "RED", "text": f"Token-2022 {k} present: transfers are programmable by the authority"}); score += 2
        creator = r.get("creator")
        cbal = (r.get("creatorBalance") or 0) / 10 ** dec
        cpct = 100 * cbal / supply if supply else 0
        ds = deployer_recent_sells(creator, ca)
        if ds.get("checked"):
            out_pct = 100 * ds["tokens_out"] / supply if supply else 0
            if out_pct >= 1:
                ev.append({"level": "RED", "text": f"deployer moved {out_pct:.1f}% of supply out in last 30m ({ds['examined']} txs read)"}); score += 4
            elif ds["tokens_out"] > 0:
                ev.append({"level": "YELLOW", "text": f"deployer moved {out_pct:.2f}% of supply in last 30m"}); score += 1
            else:
                ev.append({"level": "OK", "text": f"deployer not selling: {ds['recent_txs']} txs in 30m, 0 tokens out; holds {cpct:.1f}%"})
        mk = r.get("markets") or []
        tot_liq = r.get("totalMarketLiquidity") or 0
        locked = sum(x["lp"].get("lpLockedUSD", 0) for x in mk)
        lp_pct = 100 * locked / tot_liq if tot_liq else 0
        if tot_liq and lp_pct < 50:
            ev.append({"level": "YELLOW", "text": f"only {lp_pct:.0f}% of LP locked/burned"}); score += 1
        else:
            ev.append({"level": "OK", "text": f"{lp_pct:.0f}% of LP locked/burned"})
        known = r.get("knownAccounts", {})
        th = [h for h in r.get("topHolders", []) if h["owner"] not in known]
        top10 = sum(h["pct"] for h in th[:10])
        base = _baseline.get(ca)
        now_snap = {"t": time.time(), "liq": (m or {}).get("liq", 0), "top10": top10,
                    "holders": {h["owner"]: h["pct"] for h in th[:10]}}
        if base:
            age_m = (now_snap["t"] - base["t"]) / 60
            if base["liq"] and now_snap["liq"] < 0.6 * base["liq"]:
                ev.append({"level": "RED", "text": f"liquidity down {100*(1-now_snap['liq']/base['liq']):.0f}% since first seen {age_m:.0f}m ago"}); score += 3
            drop = base["top10"] - top10
            dumped = [o[:6] for o, p in base["holders"].items() if now_snap["holders"].get(o, 0) < 0.5 * p]
            if drop >= 8 or len(dumped) >= 3:
                ev.append({"level": "RED", "text": f"top-10 holders down {drop:.1f} pts since first seen; {len(dumped)} of them dumped >50%"}); score += 3
            elif drop >= 3:
                ev.append({"level": "YELLOW", "text": f"top-10 holders down {drop:.1f} pts since first seen ({age_m:.0f}m)"}); score += 1
            else:
                ev.append({"level": "OK", "text": f"top-10 holders flat ({top10:.1f}%) vs first seen {age_m:.0f}m ago"})
        else:
            _baseline[ca] = now_snap
            ev.append({"level": "INFO", "text": f"baseline taken: top-10 {top10:.1f}%, liq ${now_snap['liq']:,.0f}. Holder/LP deltas available from next refresh."})
        nets = r.get("insiderNetworks") or []
        if nets:
            tot = 100 * sum(n["currentHolding"] for n in nets) / tok["supply"]
            if tot >= 15:
                ev.append({"level": "RED", "text": f"insider networks hold {tot:.0f}%"}); score += 2
    else:
        ev.append({"level": "INFO", "text": "rugcheck unavailable; contract checks skipped"})
    # Socials still alive
    if m:
        for w in m["websites"][:1]:
            try:
                req = urllib.request.Request(w, headers=UA, method="GET")
                with urllib.request.urlopen(req, timeout=8) as resp:
                    ev.append({"level": "OK", "text": f"website up ({resp.status})"})
            except Exception as e:  # noqa: BLE001
                ev.append({"level": "YELLOW", "text": f"website not reachable: {str(e)[:60]}"}); score += 1
        if not m["websites"] and not m["socials"]:
            ev.append({"level": "INFO", "text": "no website/socials listed"})
        c = m["chg"]
        ev.append({"level": "INFO", "text": f"price m5 {c.get('m5')}%  h1 {c.get('h1')}%  | liq ${m['liq']:,.0f}  mcap ${m['mcap']:,.0f}"})
    verdict = "RUG" if score >= 4 else ("WATCH" if score >= 2 else "DIP")
    action = {"RUG": "Sell everything now. Do not wait for a bounce.",
              "WATCH": "Not confirmed. Re-run in 2 minutes; do not add. Sell only if a RED line appears.",
              "DIP": "No dev/LP/holder event. This is a dip. Thesis book: hands off. Main book: your stop decides, not the candle."}[verdict]
    return {"verdict": verdict, "score": score, "action": action, "evidence": ev, "ts": time.time()}


# --------------------------------------------------------------------------- #
# Watchlist + alerts
# --------------------------------------------------------------------------- #

_watch_lock = threading.Lock()


def load_watch():
    try:
        with open(WATCH_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return []


def save_watch(items):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(WATCH_FILE, "w") as f:
        json.dump(items, f, indent=1)


def watch_status():
    """Evaluate every watch item once; returns items with current mcap and any alerts fired."""
    with _watch_lock:
        items = load_watch()
    out, alerts = [], []
    for it in items:
        m = market_snapshot(it["ca"], it.get("chain", "solana"))
        mcap = (m or {}).get("mcap") or 0
        it = dict(it)
        it["mcap"] = mcap
        it["liq"] = (m or {}).get("liq")
        it["name"] = (m or {}).get("name") or it.get("name")
        now = time.time()
        fired = []
        if it.get("stop_mcap") and mcap and mcap <= it["stop_mcap"] and not it.get("stop_fired"):
            fired.append(f"STOP hit: {it['name']} at ${mcap/1e6:.2f}M (stop ${it['stop_mcap']/1e6:.2f}M)")
            it["stop_fired"] = now
        if it.get("target_mcap") and mcap and mcap >= it["target_mcap"] and not it.get("target_fired"):
            fired.append(f"TARGET hit: {it['name']} at ${mcap/1e6:.2f}M (target ${it['target_mcap']/1e6:.2f}M)")
            it["target_fired"] = now
        if it.get("hands_off_until") and now >= it["hands_off_until"] and not it.get("hands_off_fired"):
            fired.append(f"Hands-off period over for {it['name']}. Run /rug, then decide.")
            it["hands_off_fired"] = now
        it["alerts"] = fired
        alerts.extend(fired)
        out.append(it)
    with _watch_lock:
        save_watch([{k: v for k, v in it.items() if k not in ("alerts", "mcap", "liq")} for it in out])
    return {"items": out, "alerts": alerts, "ts": time.time()}


def watch_add(body):
    with _watch_lock:
        items = [i for i in load_watch() if i["ca"] != body["ca"]]
        items.append({k: body.get(k) for k in ("ca", "chain", "name", "entry_mcap", "stop_mcap", "target_mcap", "book", "hands_off_until", "size_sol", "note")})
        save_watch(items)
    return {"ok": True, "count": len(items)}


def watch_remove(ca):
    with _watch_lock:
        items = [i for i in load_watch() if i["ca"] != ca]
        save_watch(items)
    return {"ok": True, "count": len(items)}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        ca, chain = q.get("ca", "").strip(), q.get("chain") or "solana"
        try:
            if u.path == "/health":
                return self._send(200, {"ok": True, "token_check": os.path.exists(TOKEN_CHECK), "port": PORT})
            if u.path == "/resolve":
                return self._send(200, cached(("resolve", q.get("q", "")), 600, lambda: resolve(q.get("q", ""))))
            if u.path == "/watch":
                return self._send(200, cached(("watch",), 15, watch_status))
            if not ca:
                return self._send(400, {"error": "ca required"})
            if u.path == "/check":
                return self._send(200, run_check(ca, chain))
            if u.path == "/live":
                return self._send(200, cached(("live", ca), 8, lambda: live(ca, chain)))
            if u.path == "/plan":
                e = float(q["entry"]) if q.get("entry") else None
                s = float(q["size_sol"]) if q.get("size_sol") else None
                p = float(q["sol_usd"]) if q.get("sol_usd") else None
                return self._send(200, plan(ca, chain, e, s, p))
            if u.path == "/rug":
                return self._send(200, cached(("rug", ca), 20, lambda: rug_or_dip(ca, chain)))
            return self._send(404, {"error": "no such route"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if u.path == "/watch":
            if not body.get("ca"):
                return self._send(400, {"error": "ca required"})
            with _cache_lock:
                _cache.pop(("watch",), None)
            return self._send(200, watch_add(body))
        return self._send(404, {"error": "no such route"})

    def do_DELETE(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if u.path == "/watch" and q.get("ca"):
            with _cache_lock:
                _cache.pop(("watch",), None)
            return self._send(200, watch_remove(q["ca"]))
        return self._send(404, {"error": "no such route"})


def main():
    if not os.path.exists(TOKEN_CHECK):
        print(f"warning: token_check.py not found at {TOKEN_CHECK}; /check will fail", file=sys.stderr)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"copilot server on http://127.0.0.1:{PORT}  (ctrl-c to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
