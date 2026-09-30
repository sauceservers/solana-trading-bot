#!/usr/bin/env python3
"""
token_check.py — one-shot due-diligence report for a memecoin address.

Usage:
    python3 token_check.py <address> [--chain <id>] [--json] [--full] [--no-chain]

Supports Solana mints (base58) and EVM tokens (0x…) on Robinhood Chain, BSC,
Ethereum, Base and Arbitrum. Chain is auto-detected from DexScreener when not
given. Standard library only; no API keys required.

Sections:
    MARKET       DexScreener aggregate: price, cap, liquidity, volume, age, socials
    CONTRACT     Authorities / owner / tax / proxy / dangerous selectors
    HOLDERS      Top holders, concentration, wallet-cluster detection, burn
    LAUNCH       Who got the first tokens and whether they still hold them
    ACTIVITY     Recent-window trader concentration (bot / bundler detection)
    CANDLES      1-minute range analysis (bot-churn detection)
    FLAGS        Consolidated red/yellow flags with a one-line verdict
"""

import argparse
import collections
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.request

UA = {"user-agent": "Mozilla/5.0 (token_check)", "accept": "application/json"}

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
ZERO = "0x" + "0" * 40
DEAD = "0x000000000000000000000000000000000000dead"

# Pre-computed keccak selectors so the script has no crypto dependency.
SEL = {
    "name()": "0x06fdde03", "symbol()": "0x95d89b41", "decimals()": "0x313ce567",
    "totalSupply()": "0x18160ddd", "owner()": "0x8da5cb5b", "getOwner()": "0x893d20e8",
    "paused()": "0x5c975abb", "implementation()": "0x5c60da1b",
    "getOwners()": "0xa0e67e2b", "getThreshold()": "0xe75235b8",
    "maxTxAmount()": "0x8c0b5e22", "_maxTxAmount()": "0x7d1db4a5", "maxWallet()": "0xf8b45b05",
    "_maxWalletSize()": "0x8f9a55c0", "tradingEnabled()": "0x4ada218b", "tradingOpen()": "0xffb54a99",
    "buyTax()": "0x4f7041a5", "sellTax()": "0xcc1776d3", "_taxFee()": "0x3b124fe7", "totalFees()": "0x13114a9d",
}
# Selectors whose presence in bytecode is a control / rug vector.
DANGEROUS_SEL = {
    "mint": "0x40c10f19", "blacklist": "0xf9f92be4", "setBlacklist": "0x153b0d1e", "addBots": "0xd34628cc",
    "isBot": "0x3bbac579", "setFee": "0x52f7c988", "setTaxes": "0xc647b20e", "setBuyTax": "0xdc1052e2",
    "setSellTax": "0x8cd09d50", "setMaxTxAmount": "0xec28438a", "removeLimits": "0x751039fc",
    "openTrading": "0xc9567bf9", "enableTrading": "0x8a8c523c", "pause": "0x8456cb59",
    "setSwapEnabled": "0xe01af92c", "excludeFromFee": "0xdf8408fe", "excludeFromFees": "0xc0246668",
    "upgradeTo": "0x3659cfe6", "upgradeToAndCall": "0x4f1ef286", "freeze": "0x8d1fdf2f",
    "setRule": "0x3aa633aa", "setAntiWhale": "0x4a5566bf", "setLimits": "0xc4590d3f",
    "rescueERC20": "0x8cd4426d", "withdrawStuckETH": "0xf5648a4f", "manualSwap": "0x51bc3c85",
    "setMarketingWallet": "0x5d098b38",
}
BENIGN_SEL = {"transfer": "0xa9059cbb", "approve": "0x095ea7b3", "transferFrom": "0x23b872dd",
              "burn": "0x42966c68", "permit": "0xd505accf", "renounceOwnership": "0x715018a6",
              "transferOwnership": "0xf2fde38b"}

# chainId (DexScreener) -> RPC endpoints, GeckoTerminal network, GoPlus chain id, block time (s)
EVM_CHAINS = {
    "robinhood": {"rpc": ["https://rpc.mainnet.chain.robinhood.com"], "gt": "robinhood", "goplus": None, "bt": 0.1},
    # publicnode is the only free BSC endpoint that serves eth_getLogs (recent history only);
    # the dataseed nodes answer "limit exceeded" for every log query but are fine for eth_call.
    "bsc": {"rpc": ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org", "https://bsc-dataseed1.defibit.io"], "gt": "bsc", "goplus": "56", "bt": 0.75},
    "ethereum": {"rpc": ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://rpc.ankr.com/eth"], "gt": "eth", "goplus": "1", "bt": 12},
    "base": {"rpc": ["https://mainnet.base.org", "https://base-rpc.publicnode.com"], "gt": "base", "goplus": "8453", "bt": 2},
    "arbitrum": {"rpc": ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"], "gt": "arbitrum", "goplus": "42161", "bt": 0.25},
}
SOL_RPCS = ["https://api.mainnet-beta.solana.com"]

# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #

def http_json(url, data=None, headers=None, retries=4, timeout=40):
    h = dict(UA)
    if headers:
        h.update(headers)
    body = json.dumps(data).encode() if data is not None else None
    if body is not None:
        h["content-type"] = "application/json"
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and i < retries - 1:
                time.sleep(1.5 * (i + 1))
                continue
            return {"__error__": f"HTTP {e.code}"}
        except Exception as e:  # noqa: BLE001
            if i < retries - 1:
                time.sleep(1.0 * (i + 1))
                continue
            return {"__error__": str(e)[:120]}
    return {"__error__": "unreachable"}


class Rpc:
    """Round-robin JSON-RPC client with 429 back-off and rate-limit-aware log paging."""

    def __init__(self, urls):
        self.urls = urls
        self.i = 0

    def call(self, method, params):
        last = {"error": {"message": "rpc exhausted"}}
        for attempt in range(2 * len(self.urls) + 2):
            idx = (self.i + attempt) % len(self.urls)
            r = http_json(self.urls[idx], {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                          headers={"user-agent": "curl/8.5.0"}, retries=1)
            if "__error__" in r:
                last = {"error": {"message": r["__error__"]}}
                # Hard refusals (403 etc.) are policy, not load — rotate once without sleeping.
                if not r["__error__"].startswith("HTTP 4") or r["__error__"] == "HTTP 429":
                    time.sleep(0.3 * (attempt + 1))
                if attempt >= len(self.urls):
                    return last
                continue
            if "error" in r:
                msg = str(r["error"]).lower()
                last = r
                # Range/result-size limits are per-endpoint policy: try the next endpoint once,
                # then hand the error back so the caller can shrink the block span.
                if attempt < len(self.urls) and any(k in msg for k in ("limit", "exceed", "range", "more than", "too many")):
                    continue
                return r
            self.i = idx  # remember the endpoint that worked
            return r
        return last

    def result(self, method, params, default=None):
        r = self.call(method, params)
        return r.get("result", default)


def fmt_usd(v):
    if v is None:
        return "-"
    v = float(v)
    if v >= 1e9:
        return f"${v/1e9:.2f}B"
    if v >= 1e6:
        return f"${v/1e6:.2f}M"
    if v >= 1e3:
        return f"${v/1e3:.0f}K"
    return f"${v:.0f}"


def pct(a, b):
    return 100.0 * a / b if b else 0.0


def ts(t):
    return dt.datetime.fromtimestamp(t, dt.UTC).strftime("%Y-%m-%d %H:%M:%S")


# --------------------------------------------------------------------------- #
# MARKET (DexScreener)
# --------------------------------------------------------------------------- #

def market(addr):
    d = http_json(f"https://api.dexscreener.com/latest/dex/tokens/{addr}")
    pairs = (d or {}).get("pairs") or []
    if not pairs:
        return None
    pairs.sort(key=lambda p: -((p.get("liquidity") or {}).get("usd") or 0))
    top = pairs[0]
    liq = sum((p.get("liquidity") or {}).get("usd") or 0 for p in pairs)
    vol = {k: sum((p.get("volume") or {}).get(k) or 0 for p in pairs) for k in ("m5", "h1", "h6", "h24")}
    tx = {k: (sum(p["txns"][k]["buys"] for p in pairs), sum(p["txns"][k]["sells"] for p in pairs)) for k in ("m5", "h1", "h6", "h24")}
    created = min((p.get("pairCreatedAt") for p in pairs if p.get("pairCreatedAt")), default=None)
    info = top.get("info") or {}
    return {
        "chain": top["chainId"], "dex": top["dexId"], "labels": top.get("labels"),
        "symbol": top["baseToken"]["symbol"], "name": top["baseToken"]["name"],
        "quote": top["quoteToken"]["symbol"], "price": float(top.get("priceUsd") or 0),
        "mcap": top.get("marketCap") or top.get("fdv") or 0, "liq_total": liq, "liq_top": (top.get("liquidity") or {}).get("usd") or 0,
        "vol": vol, "tx": tx, "chg": top.get("priceChange") or {}, "pairs": len(pairs),
        "top_pair": top["pairAddress"], "created_ms": created,
        "age_h": (time.time() * 1000 - created) / 3.6e6 if created else None,
        "websites": [w["url"] for w in info.get("websites", [])],
        "socials": [s["url"] for s in info.get("socials", [])],
        "boosts": (top.get("boosts") or {}).get("active"),
    }


def print_market(m):
    print("== MARKET ==")
    print(f"{m['name']} ({m['symbol']}) on {m['chain']} | {m['dex']} {m['labels'] or ''} / {m['quote']} | {m['pairs']} pools")
    age = f"{m['age_h']:.1f}h" if m["age_h"] is not None and m["age_h"] < 48 else (f"{m['age_h']/24:.1f}d" if m["age_h"] else "?")
    print(f"price {m['price']:.8g}  mcap {fmt_usd(m['mcap'])}  liq {fmt_usd(m['liq_total'])} ({pct(m['liq_total'], m['mcap']):.1f}% of cap)  age {age}")
    v, t = m["vol"], m["tx"]
    print(f"vol  m5 {fmt_usd(v['m5'])}  h1 {fmt_usd(v['h1'])}  h24 {fmt_usd(v['h24'])}  | vol24/liq {v['h24']/max(m['liq_total'],1):.1f}x")
    print(f"txns m5 {t['m5'][0]}b/{t['m5'][1]}s  h1 {t['h1'][0]}b/{t['h1'][1]}s  h24 {t['h24'][0]}b/{t['h24'][1]}s  ({(t['m5'][0]+t['m5'][1])/5:.0f} tx/min last 5m)")
    c = m["chg"]
    print(f"chg  m5 {c.get('m5')}%  h1 {c.get('h1')}%  h6 {c.get('h6')}%  h24 {c.get('h24')}%")
    print(f"web {m['websites'] or '-'}  socials {m['socials'] or '-'}  boosts {m['boosts'] or '-'}")


# --------------------------------------------------------------------------- #
# SOLANA
# --------------------------------------------------------------------------- #

def solana_report(addr, flags, full):
    r = http_json(f"https://api.rugcheck.xyz/v1/tokens/{addr}/report")
    if "token" not in r:
        print(f"== CONTRACT ==\nrugcheck unavailable: {r.get('__error__') or r}")
        return solana_rpc_fallback(addr, flags)
    tok = r["token"]
    dec = tok["decimals"]
    sup = tok["supply"] / 10 ** dec
    meta = r.get("tokenMeta") or {}
    ext = r.get("token_extensions") or {}
    fee = r.get("transferFee") or {}
    print("== CONTRACT ==")
    prog = "Token-2022" if r["tokenProgram"].startswith("Tokenz") else "SPL"
    print(f"program {prog}  supply {sup:,.0f}  mintAuth {r.get('mintAuthority')}  freezeAuth {r.get('freezeAuthority')}  metadata mutable={meta.get('mutable')}")
    print(f"launchpad {(r.get('launchpad') or {}).get('name')}  deployPlatform {r.get('deployPlatform')}  creator {r.get('creator')}  creatorBal {r.get('creatorBalance', 0)/10**dec:,.0f}")
    if r.get("mintAuthority"):
        flags.append(("RED", "mint authority still set"))
    if r.get("freezeAuthority"):
        flags.append(("RED", "freeze authority still set"))
    tf = ext.get("transferFeeConfig") if isinstance(ext, dict) else None
    if tf:
        bps = (tf.get("newerTransferFee") or {}).get("transferFeeBasisPoints", 0)
        print(f"transfer fee {bps/100:.2f}% (authority {tf.get('transferFeeConfigAuthority')}, withheld {tf.get('withheldAmount',0)/10**dec:,.0f})")
        flags.append(("YELLOW", f"Token-2022 transfer fee {bps/100:.2f}% on every transfer; fee authority can change it"))
    bad_ext = [k for k in ("permanentDelegate", "transferHook", "pausableConfig", "defaultAccountState") if isinstance(ext, dict) and ext.get(k)]
    if bad_ext:
        flags.append(("RED", f"Token-2022 control extensions present: {bad_ext}"))
    if meta.get("mutable"):
        flags.append(("YELLOW", "metadata mutable"))
    for rk in r.get("risks", []):
        if "mutable metadata" in str(rk.get("name", "")).lower():
            continue  # already flagged above
        lvl = "RED" if rk.get("level") == "danger" else "YELLOW"
        flags.append((lvl, f"rugcheck: {rk.get('name')} {rk.get('value') or ''}".strip()))

    print("== HOLDERS ==")
    known = r.get("knownAccounts", {})
    th = r.get("topHolders", [])
    nonlp = [h for h in th if h["owner"] not in known]
    top10 = sum(h["pct"] for h in nonlp[:10])
    print(f"holders {r.get('totalHolders')}  top1 {nonlp[0]['pct'] if nonlp else 0:.1f}%  top10(non-LP) {top10:.1f}%  insider-flagged {sum(h['pct'] for h in th if h.get('insider')):.1f}%")
    nets = r.get("insiderNetworks") or []
    if nets:
        tot = sum(n["currentHolding"] for n in nets) / tok["supply"] * 100
        big = sorted(nets, key=lambda n: -n["currentHolding"])[:3]
        print(f"insider networks {len(nets)} holding {tot:.1f}%: " + ", ".join(f"{n['size']}w/{n['type']}/{100*n['currentHolding']/tok['supply']:.1f}%" for n in big))
        if tot >= 15:
            flags.append(("RED", f"insider networks hold {tot:.1f}% of supply"))
        elif tot >= 7:
            flags.append(("YELLOW", f"insider networks hold {tot:.1f}% of supply"))
        if any(n["size"] >= 200 for n in nets):
            flags.append(("YELLOW", f"very large wallet cluster ({max(n['size'] for n in nets)} wallets) — airdrop or bundler farm"))
    if top10 >= 35:
        flags.append(("RED", f"top10 non-LP holders {top10:.1f}%"))
    elif top10 >= 25:
        flags.append(("YELLOW", f"top10 non-LP holders {top10:.1f}%"))
    if full:
        for h in th[:12]:
            print(f"  {h['owner']} {h['pct']:6.2f}% {known.get(h['owner'],{}).get('name','')} {'INSIDER' if h.get('insider') else ''}")

    print("== LIQUIDITY ==")
    mk = r.get("markets") or []
    locked_usd = sum(m["lp"].get("lpLockedUSD", 0) for m in mk)
    tot_liq = r.get("totalMarketLiquidity") or 0
    for m in mk[:4]:
        lp = m["lp"]
        print(f"  {m['marketType']:16} {m['pubkey'][:8]}… locked {lp.get('lpLockedPct',0):.0f}% (${lp.get('lpLockedUSD',0):,.0f}) quote ${lp.get('quoteUSD',0):,.0f}")
    print(f"total liq ${tot_liq:,.0f}  locked ${locked_usd:,.0f} ({pct(locked_usd, tot_liq):.0f}%)")
    if tot_liq and pct(locked_usd, tot_liq) < 50:
        flags.append(("YELLOW", f"only {pct(locked_usd, tot_liq):.0f}% of liquidity is locked"))

    # Bags.fm fee-share lookup (creator authority prefix BAGS)
    if str(r.get("creator", "")).startswith("BAGS") or (r.get("launchpad") or {}).get("name", "").lower().startswith("bags"):
        b = http_json(f"https://api2.bags.fm/api/v1/token-launch/creator/v3?tokenMint={addr}")
        if isinstance(b, dict) and b.get("response"):
            shares = [f"{x.get('providerUsername') or x.get('wallet','')[:8]}:{x.get('royaltyBps',0)/100:.0f}%" for x in b["response"]]
            print(f"bags fee-share -> {shares}")
    uri = meta.get("uri")
    if uri and full:
        mj = http_json(uri)
        if isinstance(mj, dict) and "__error__" not in mj:
            print(f"metadata: {json.dumps({k: mj.get(k) for k in ('name','symbol','description','twitter','website','telegram') if mj.get(k)})[:300]}")
    return {"supply": sup, "holders": r.get("totalHolders")}


def solana_rpc_fallback(addr, flags):
    rpc = Rpc(SOL_RPCS)
    v = rpc.result("getAccountInfo", [addr, {"encoding": "jsonParsed"}], {}) or {}
    info = ((v.get("value") or {}).get("data") or {}).get("parsed", {}).get("info", {})
    if not info:
        print("solana rpc: no mint info")
        return {}
    print(f"program {(v.get('value') or {}).get('owner')}  mintAuth {info.get('mintAuthority')}  freezeAuth {info.get('freezeAuthority')}  supply {int(info.get('supply',0))/10**info.get('decimals',0):,.0f}")
    if info.get("mintAuthority"):
        flags.append(("RED", "mint authority still set"))
    if info.get("freezeAuthority"):
        flags.append(("RED", "freeze authority still set"))
    for e in info.get("extensions", []):
        if e.get("extension") in ("permanentDelegate", "transferHook", "pausableConfig", "transferFeeConfig"):
            flags.append(("YELLOW" if e["extension"] == "transferFeeConfig" else "RED", f"Token-2022 extension {e['extension']}"))
    return {}


# --------------------------------------------------------------------------- #
# EVM
# --------------------------------------------------------------------------- #

def evm_call(rpc, to, sel):
    r = rpc.result("eth_call", [{"to": to, "data": sel}, "latest"])
    return r if r and r != "0x" else None


def dec_string(h):
    try:
        b = bytes.fromhex(h[2:])
        if len(b) >= 64:
            n = int.from_bytes(b[32:64], "big")
            return b[64:64 + n].decode(errors="replace")
        return b.rstrip(b"\0").decode(errors="replace")
    except Exception:  # noqa: BLE001
        return None


def classify(rpc, addr, cache):
    if addr in cache:
        return cache[addr]
    code = rpc.result("eth_getCode", [addr, "latest"], "0x") or "0x"
    if len(code) <= 2:
        k = "EOA"
    elif code.lower().startswith("0xef0100"):
        k = "7702->" + code[8:16]
    else:
        k = f"CONTRACT({len(code)//2})"
    cache[addr] = k
    return k


def get_logs(rpc, addr, frm, to, topics, span, budget_s=150):
    """Page eth_getLogs, shrinking the span on provider limits and growing it back on success."""
    out = []
    cur = frm
    min_span = 25
    t0 = time.time()
    fails_at_min = 0
    while cur <= to and time.time() - t0 < budget_s:
        hi = min(to, cur + span)
        r = rpc.call("eth_getLogs", [{"fromBlock": hex(cur), "toBlock": hex(hi), "address": addr, "topics": topics}])
        if "error" in r:
            if span > min_span:
                span = max(min_span, span // 3)
                continue
            fails_at_min += 1
            if fails_at_min >= 3:  # endpoint refuses even tiny pages; skip this page
                cur = hi + 1
                fails_at_min = 0
            continue
        out += r["result"]
        cur = hi + 1
        fails_at_min = 0
        if len(r["result"]) < 2000 and span < 5000:
            span = min(5000, span * 2)
    if cur <= to:
        print(f"(log paging stopped at block {cur} of {to} — time budget exhausted; results partial)")
    return out


def evm_report(addr, chain, m, flags, full, do_chain):
    cfg = EVM_CHAINS.get(chain)
    print("== CONTRACT ==")
    gp = None
    if cfg and cfg["goplus"]:
        g = http_json(f"https://api.gopluslabs.io/api/v1/token_security/{cfg['goplus']}?contract_addresses={addr}")
        gp = ((g or {}).get("result") or {}).get(addr.lower())
    if gp:
        keys = ["is_open_source", "is_proxy", "is_mintable", "is_honeypot", "cannot_sell_all", "transfer_pausable", "is_blacklisted",
                "slippage_modifiable", "owner_change_balance", "hidden_owner", "selfdestruct", "external_call", "trading_cooldown", "is_anti_whale"]
        bad = [k for k in keys if k != "is_open_source" and gp.get(k) == "1"]
        print(f"goplus: open_source={gp.get('is_open_source')} owner={gp.get('owner_address') or '-'} tax b/s={gp.get('buy_tax') or '?'}/{gp.get('sell_tax') or '?'} holders={gp.get('holder_count')} creator%={gp.get('creator_percent')} flags={bad or 'none'}")
        for k in bad:
            flags.append(("RED" if k in ("is_honeypot", "cannot_sell_all", "is_mintable", "hidden_owner", "owner_change_balance", "selfdestruct") else "YELLOW", f"goplus {k}=1"))
        if gp.get("is_open_source") == "0":
            flags.append(("YELLOW", "contract not open source (goplus)"))
        for tx_k in ("buy_tax", "sell_tax"):
            try:
                if float(gp.get(tx_k) or 0) >= 0.05:
                    flags.append(("YELLOW", f"{tx_k} {float(gp[tx_k])*100:.0f}%"))
            except ValueError:
                pass
        lps = gp.get("lp_holders") or []
        if lps:
            locked = sum(float(h["percent"]) for h in lps if h.get("is_locked") == 1 or h.get("address", "").lower() in (DEAD, ZERO))
            print(f"goplus LP: {len(lps)} holders, locked/burned {locked*100:.0f}%")
            if locked < 0.5:
                flags.append(("YELLOW", f"LP only {locked*100:.0f}% locked/burned (goplus)"))
    else:
        print(f"goplus: no data for chain '{chain}'" if not cfg or not cfg["goplus"] else "goplus: token not indexed yet")

    if not cfg or not do_chain:
        print("(rpc analysis skipped: unsupported chain or --no-chain)")
        return
    rpc = Rpc(cfg["rpc"])
    code = rpc.result("eth_getCode", [addr, "latest"], "0x") or "0x"
    if len(code) <= 2:
        print("no bytecode at address on this chain")
        flags.append(("RED", "address has no code on selected chain"))
        return
    name = dec_string(evm_call(rpc, addr, SEL["name()"]) or "0x")
    sym = dec_string(evm_call(rpc, addr, SEL["symbol()"]) or "0x")
    dec_raw = evm_call(rpc, addr, SEL["decimals()"])
    dec = int(dec_raw, 16) if dec_raw else 18
    sup_raw = evm_call(rpc, addr, SEL["totalSupply()"])
    sup = int(sup_raw, 16) if sup_raw else 0
    owner = evm_call(rpc, addr, SEL["owner()"]) or evm_call(rpc, addr, SEL["getOwner()"])
    owner = "0x" + owner[-40:] if owner else None
    impl_slot = rpc.result("eth_getStorageAt", [addr, EIP1967_IMPL_SLOT, "latest"], "0x0")
    is_proxy = bool(int(impl_slot or "0x0", 16)) or DANGEROUS_SEL["upgradeTo"][2:] in code
    lc = code.lower()
    impl_note = ""
    # EIP-1167 minimal proxy (clone): logic lives in the implementation, scan that instead.
    mm = re.search(r"363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3", lc)
    if mm:
        impl = "0x" + mm.group(1)
        impl_code = rpc.result("eth_getCode", [impl, "latest"], "0x") or "0x"
        lc = impl_code.lower()
        impl_note = f"  (EIP-1167 clone of {impl}, {len(impl_code)//2}B — selectors scanned on implementation)"
    elif is_proxy and int(impl_slot or "0x0", 16):
        impl = "0x" + impl_slot[-40:]
        impl_code = rpc.result("eth_getCode", [impl, "latest"], "0x") or "0x"
        lc = impl_code.lower()
        impl_note = f"  (EIP-1967 proxy -> {impl}, selectors scanned on implementation)"
    danger = [k for k, s in DANGEROUS_SEL.items() if s[2:] in lc]
    benign = [k for k, s in BENIGN_SEL.items() if s[2:] in lc]
    state = {}
    for k in ("paused()", "tradingEnabled()", "tradingOpen()", "buyTax()", "sellTax()", "_taxFee()", "maxTxAmount()", "_maxTxAmount()", "maxWallet()", "_maxWalletSize()"):
        v = evm_call(rpc, addr, SEL[k])
        if v:
            state[k.strip("_()")] = int(v, 16)
    print(f"{name} ({sym}) dec {dec} supply {sup/10**dec:,.0f} bytecode {len(code)//2}B{impl_note}")
    print(f"owner {owner or 'none/renounced'}  proxy {is_proxy}  benign {benign}")
    print(f"control selectors: {danger or 'none'}  state: {state or '-'}")
    if owner and owner != ZERO and owner != DEAD:
        okind = classify(rpc, owner, {})
        flags.append(("YELLOW" if danger else "INFO", f"owner set ({okind}) with selectors {danger}" if danger else f"owner set ({okind}) but no control selectors found"))
    if is_proxy:
        flags.append(("RED", "upgradeable proxy — logic can be swapped"))
    hard = {"mint", "blacklist", "setBlacklist", "addBots", "freeze", "pause", "setRule"}
    if hard & set(danger):
        flags.append(("RED", f"rug-capable functions present: {sorted(hard & set(danger))}"))
    elif danger:
        flags.append(("YELLOW", f"owner-controlled parameters: {danger}"))

    # ---- Transfer-log holder rebuild ---------------------------------------
    latest = int(rpc.result("eth_blockNumber", [], "0x0"), 16)
    age_h = m["age_h"] if m and m["age_h"] else 24
    lookback = int(min(age_h * 3600 / cfg["bt"] * 1.15 + 2000, 400_000 if cfg["bt"] < 1 else 60_000))
    frm = max(0, latest - lookback)
    span = 2000 if cfg["bt"] < 1 else 5000
    history_note = ""
    # Free-tier RPCs often refuse logs older than a few thousand blocks (HTTP 403, "archive",
    # "limit exceeded"...). Probe the deepest page with a tiny range; if refused, binary-search
    # forward for the oldest block the endpoint will actually serve and start there.
    def probe(b):
        r = rpc.call("eth_getLogs", [{"fromBlock": hex(b), "toBlock": hex(b + 20), "address": addr, "topics": [TRANSFER_TOPIC]}])
        return "result" in r
    if frm > 0 and not probe(frm):
        lo, hi = frm, latest
        while hi - lo > 500:
            mid = (lo + hi) // 2
            if probe(mid):
                hi = mid
            else:
                lo = mid
        history_note = f" (RPC only serves the last ~{(latest-hi)*cfg['bt']/3600:.1f}h of logs; older history unavailable)"
        frm = hi
    logs = get_logs(rpc, addr, frm, latest, [TRANSFER_TOPIC], span)
    if gp and gp.get("holders"):
        hs = gp["holders"][:8]
        print("== HOLDERS (goplus snapshot) ==")
        print(f"goplus holder_count {gp.get('holder_count')}  top10 {100*sum(float(h['percent']) for h in gp['holders'][:10]):.1f}%")
        for h in hs:
            print(f"  {h['address']} {100*float(h['percent']):6.2f}% {'CONTRACT' if h.get('is_contract') else 'EOA'} {h.get('tag') or ''} {'locked' if h.get('is_locked') else ''}")
    if not logs:
        print(f"== HOLDERS ==\nno Transfer logs in lookback window (token older than window?){history_note}")
        return
    logs.sort(key=lambda l: (int(l["blockNumber"], 16), int(l.get("logIndex", "0x0"), 16)))
    complete = not logs[0]["topics"][1].endswith("0" * 40) and frm > 0 and lookback >= 400_000 * 0.99
    mints = [l for l in logs if l["topics"][1].endswith("0" * 40)]
    bal = collections.Counter()
    for l in logs:
        f = "0x" + l["topics"][1][-40:]
        t = "0x" + l["topics"][2][-40:]
        v = int(l["data"], 16) if l["data"] != "0x" else 0
        bal[f] -= v
        bal[t] += v
    bal.pop(ZERO, None)
    burned = bal.get(DEAD, 0)
    holders = sorted([(a, v) for a, v in bal.items() if v > 10 ** (dec - 3)], key=lambda x: -x[1])
    total = sup or sum(v for _, v in holders)
    cache = {}
    print("== HOLDERS ==")
    print(f"transfer logs {len(logs)} over {(latest-frm)*cfg['bt']/3600:.1f}h  holders(rebuilt) {len(holders)}  burned {pct(burned,total):.2f}%  {'(mint seen — full history)' if mints else '(mint NOT in window — balances partial)'}{history_note}")
    pools = set()
    if m:
        d = http_json(f"https://api.dexscreener.com/latest/dex/tokens/{addr}")
        pools = {p["pairAddress"].lower() for p in (d.get("pairs") or [])}
    cluster = collections.Counter()
    kinds = {}
    for a, v in holders[:60]:
        k = classify(rpc, a, cache)
        kinds[a] = k
        if k.startswith("7702"):
            cluster[k] += v
    eoa_top = [v for a, v in holders[:60] if kinds[a] == "EOA"][:10]
    top10 = sum(v for _, v in holders[:10])
    print(f"top10 {pct(top10,total):.1f}%  top10 EOA {pct(sum(eoa_top),total):.1f}%  7702 smart-wallets in top60: {sum(1 for k in kinds.values() if k.startswith('7702'))}")
    if cluster:
        big = cluster.most_common(1)[0]
        print(f"largest 7702 delegate cluster {big[0]} holds {pct(big[1],total):.1f}% (top60)")
        if pct(big[1], total) >= 25:
            flags.append(("YELLOW", f"{pct(big[1],total):.0f}% of supply in one smart-wallet delegate cluster"))
    for a, v in holders[:(15 if full else 8)]:
        tag = "POOL" if a in pools else ("DEAD" if a == DEAD else kinds.get(a, ""))
        print(f"  {a} {v/10**dec:>16,.0f} {pct(v,total):6.2f}% {tag}")
    if mints:
        nonpool_top = [(a, v) for a, v in holders if a not in pools and a != DEAD and not kinds.get(a, "").startswith("CONTRACT")]
        if nonpool_top and pct(nonpool_top[0][1], total) >= 5:
            flags.append(("YELLOW", f"largest wallet holds {pct(nonpool_top[0][1],total):.1f}%"))
        big_contracts = [(a, v) for a, v in holders[:10] if kinds.get(a, "").startswith("CONTRACT") and a not in pools]
        for a, v in big_contracts:
            if pct(v, total) >= 5:
                flags.append(("YELLOW", f"non-pool contract {a[:10]}… holds {pct(v,total):.1f}% (locker/hook/treasury — check who controls it)"))
    elif gp and gp.get("holders"):
        # Rebuilt balances are partial, so concentration flags come from the GoPlus snapshot.
        gh = gp["holders"]
        gp_top10 = 100 * sum(float(h["percent"]) for h in gh[:10])
        wallets = [h for h in gh if not h.get("is_contract") and not h.get("is_locked")]
        if wallets and 100 * float(wallets[0]["percent"]) >= 5:
            flags.append(("YELLOW", f"largest wallet holds {100*float(wallets[0]['percent']):.1f}% (goplus)"))
        if gp_top10 >= 35:
            flags.append(("RED", f"top10 holders {gp_top10:.1f}% (goplus)"))
        elif gp_top10 >= 25:
            flags.append(("YELLOW", f"top10 holders {gp_top10:.1f}% (goplus)"))
    else:
        flags.append(("INFO", "holder balances rebuilt from partial history — concentration not assessed"))

    # ---- LAUNCH ------------------------------------------------------------
    print("== LAUNCH ==")
    if mints:
        fb = int(mints[0]["blockNumber"], 16)
        blk = rpc.result("eth_getBlockByNumber", [hex(fb), False], {}) or {}
        t0 = int(blk.get("timestamp", "0x0"), 16)
        minter = "0x" + mints[0]["topics"][2][-40:]
        tx0 = rpc.result("eth_getTransactionByHash", [mints[0]["transactionHash"]], {}) or {}
        print(f"minted {sum(int(l['data'],16) for l in mints)/10**dec:,.0f} to {minter} ({classify(rpc, minter, cache)}) at {ts(t0)}  deployer-tx from {tx0.get('from')} nonce-now {int(rpc.result('eth_getTransactionCount',[tx0.get('from') or ZERO,'latest'],'0x0'),16)}")
        win = int(60 / cfg["bt"])
        H = dict(holders)
        early = collections.Counter()
        early_blocks = {}
        for l in logs:
            b = int(l["blockNumber"], 16)
            if b > fb + win:
                break
            f = "0x" + l["topics"][1][-40:]
            t = "0x" + l["topics"][2][-40:]
            if f in (minter, ZERO) or f in pools or kinds.get(f, "").startswith("CONTRACT"):
                if t not in pools and t not in (ZERO, minter):
                    early[t] += int(l["data"], 16)
                    early_blocks.setdefault(t, b)
        # A contract that received tokens at launch and still holds ~all of them is
        # infrastructure (pool manager, locker, hook). A contract that received and
        # then distributed is a sniper bot and must be counted as a buyer.
        # Large contracts (routers, migrators, pool managers) that merely passed tokens
        # through are infrastructure too; small contracts (<5 KB) that dumped are bot proxies.
        buyers = {}
        for a, v in early.items():
            k = classify(rpc, a, cache)
            if k.startswith("CONTRACT"):
                size = int(k[9:-1])
                if H.get(a, 0) >= v * 0.9 or size >= 5000:
                    continue
            buyers[a] = v
        tot = min(sum(buyers.values()), total)
        still = sum(min(v, H.get(a, 0)) for a, v in buyers.items())
        print(f"first 60s: {len(buyers)} buyers took {pct(tot,total):.1f}% of supply, still hold {pct(still,total):.1f}%")
        for a, v in sorted(buyers.items(), key=lambda x: -x[1])[:5]:
            print(f"  {a} bought {pct(v,total):5.1f}%  now {pct(H.get(a,0),total):5.2f}%  {classify(rpc,a,cache)}  +{(early_blocks[a]-fb)*cfg['bt']:.0f}s")
        if pct(tot, total) >= 20 and pct(still, total) < pct(tot, total) * 0.25:
            flags.append(("RED", f"launch snipers took {pct(tot,total):.0f}% and have distributed {100-pct(still,tot):.0f}% of it — current holders are exit liquidity"))
        elif pct(tot, total) >= 20:
            flags.append(("YELLOW", f"launch snipers hold {pct(still,total):.0f}% of supply (bought {pct(tot,total):.0f}%)"))
        if len(buyers) and max(buyers.values()) / total >= 0.25:
            flags.append(("RED", f"single wallet bought {100*max(buyers.values())/total:.0f}% of supply at launch"))
    else:
        print("mint not in lookback window; launch analysis skipped")

    # ---- ACTIVITY (recent window) -----------------------------------------
    print("== ACTIVITY (last ~6 min) ==")
    win_blocks = int(360 / cfg["bt"])
    recent = [l for l in logs if int(l["blockNumber"], 16) >= latest - win_blocks]
    txs = collections.defaultdict(set)
    bought = collections.Counter()
    sold = collections.Counter()
    pool_like = pools | {a for a, k in kinds.items() if k.startswith("CONTRACT") and a in {h[0] for h in holders[:3]}}
    for l in recent:
        f = "0x" + l["topics"][1][-40:]
        t = "0x" + l["topics"][2][-40:]
        v = int(l["data"], 16)
        if f in pool_like and t not in pool_like:
            bought[t] += v
            txs[t].add(l["transactionHash"])
        elif t in pool_like and f not in pool_like:
            sold[f] += v
            txs[f].add(l["transactionHash"])
    traders = set(bought) | set(sold)
    ntx = len({l["transactionHash"] for l in recent})
    if not traders:
        print("no swap-like transfers in window")
    else:
        rt = [a for a in traders if a in bought and a in sold]
        rank = sorted(traders, key=lambda a: -len(txs[a]))
        top_share = pct(sum(len(txs[a]) for a in rank[:10]), max(ntx, 1))
        sizes = collections.Counter(round(bought[a] / total * 1e4) for a in traders if bought[a] and not sold[a])
        clones = [(s, c) for s, c in sizes.items() if c >= 3 and s >= 20]
        print(f"{ntx} txs, {len(traders)} traders, {len(rt)} round-trippers, top10 traders = {min(top_share,100):.0f}% of txs, {ntx/6:.0f} tx/min")
        skimmers = set()
        for a in rank[:(8 if full else 5)]:
            role = ""
            if len(txs[a]) >= 0.4 * ntx and not sold[a] and pct(bought[a], total) < 1:
                role = "FEE-HOOK/SKIMMER"
                skimmers.add(a)
            elif a in rt and len(txs[a]) >= 100:
                role = "VOLUME-BOT"
            print(f"  {a} txs={len(txs[a]):4d} bought {pct(bought[a],total):5.2f}% sold {pct(sold[a],total):5.2f}% net {pct(bought[a]-sold[a],total):+5.2f}% {classify(rpc,a,cache)} {role}")
        if skimmers:
            flags.append(("INFO", f"fee hook skims every swap ({', '.join(s[:10]+'…' for s in skimmers)}) — launchpad earns on all churn"))
        if clones:
            print(f"identical-size buyer clusters (bp of supply, count): {clones[:4]}")
            flags.append(("YELLOW", f"bundler pattern: {sum(c for _,c in clones)} wallets bought identical sizes with no sells"))
        if ntx / 6 >= 100 and m and m["liq_total"] < 500_000:
            flags.append(("YELLOW", f"{ntx/6:.0f} tx/min on {fmt_usd(m['liq_total'])} liquidity — bot churn"))
        heavy = [a for a in rank[:5] if len(txs[a]) >= 100 and a in rt]
        if heavy:
            flags.append(("YELLOW", f"{len(heavy)} contract/bot wallets each round-tripping 100+ times in 6 min (volume bots)"))


# --------------------------------------------------------------------------- #
# CANDLES (GeckoTerminal)
# --------------------------------------------------------------------------- #

def candles(m, flags, full):
    if not m:
        return
    net = EVM_CHAINS.get(m["chain"], {}).get("gt", m["chain"])
    if m["chain"] == "solana":
        net = "solana"
    d = http_json(f"https://api.geckoterminal.com/api/v2/networks/{net}/pools/{m['top_pair']}/ohlcv/minute?aggregate=1&limit=60")
    ol = sorted(((d.get("data") or {}).get("attributes") or {}).get("ohlcv_list") or [])
    print("== CANDLES (1m) ==")
    if not ol:
        print(f"no candle data ({d.get('__error__') or 'pool not indexed'})")
    else:
        rng = [100 * (h / l - 1) for _, o, h, l, c, v in ol if l > 0]
        med = sorted(rng)[len(rng) // 2]
        big = sum(1 for r in rng if r >= 30)
        hi = max(ol, key=lambda x: x[2])
        last = ol[-1][4]
        print(f"{len(ol)} candles  median intra-minute range {med:.1f}%  candles with >=30% range: {big}/{len(rng)}  drawdown from 1h high {100*(last/hi[2]-1):.0f}%")
        if full:
            for t, o, h, l, c, v in ol[-12:]:
                print(f"  {dt.datetime.fromtimestamp(t, dt.UTC):%H:%M} o {o:.3g} h {h:.3g} l {l:.3g} c {c:.3g} chg {100*(c/o-1):+6.1f}% range {100*(h/l-1):6.1f}% vol ${v:,.0f}")
        if med >= 25:
            flags.append(("RED", f"median 1-minute range {med:.0f}% — price is bot churn, not discovery"))
        elif med >= 10:
            flags.append(("YELLOW", f"median 1-minute range {med:.0f}% — very thin / bot-heavy"))
    # Longer view for context
    d2 = http_json(f"https://api.geckoterminal.com/api/v2/networks/{net}/pools/{m['top_pair']}/ohlcv/hour?aggregate=1&limit=168")
    ol2 = sorted(((d2.get("data") or {}).get("attributes") or {}).get("ohlcv_list") or [])
    if ol2:
        hi = max(ol2, key=lambda x: x[2])
        last = ol2[-1][4]
        first = ol2[0][4]
        print(f"7d: first close {first:.3g} -> now {last:.3g} (x{last/first if first else 0:.2f}); ATH {hi[2]:.3g} at {ts(hi[0])}; drawdown {100*(last/hi[2]-1):.0f}%")


# --------------------------------------------------------------------------- #
# Verdict
# --------------------------------------------------------------------------- #

def verdict(m, flags):
    if m:
        if m["age_h"] is not None and m["age_h"] < 6:
            flags.append(("YELLOW", f"token is {m['age_h']:.1f}h old"))
        if m["liq_total"] < 50_000:
            flags.append(("RED", f"liquidity {fmt_usd(m['liq_total'])} — cannot exit a meaningful position"))
        elif m["liq_total"] < 150_000:
            flags.append(("YELLOW", f"liquidity {fmt_usd(m['liq_total'])}"))
        if m["mcap"] and pct(m["liq_total"], m["mcap"]) < 3:
            flags.append(("YELLOW", f"liquidity only {pct(m['liq_total'], m['mcap']):.1f}% of market cap"))
        vl = m["vol"]["h24"] / max(m["liq_total"], 1)
        if vl >= 30:
            flags.append(("YELLOW", f"24h volume {vl:.0f}x liquidity — wash/bot volume likely"))
        if not m["socials"] and not m["websites"]:
            flags.append(("YELLOW", "no website or socials listed"))
        for w in m["websites"]:
            if re.search(r"truthsocial|twitter\.com/\w+/status|x\.com/\w+/status", w):
                flags.append(("INFO", "website is just a social post link"))
        c = m["chg"]
        try:
            if c.get("h1") is not None and float(c["h1"]) >= 200:
                flags.append(("YELLOW", f"+{float(c['h1']):.0f}% in the last hour — buying a vertical chart"))
        except (TypeError, ValueError):
            pass
    red = [f for l, f in flags if l == "RED"]
    yel = [f for l, f in flags if l == "YELLOW"]
    inf = [f for l, f in flags if l == "INFO"]
    print("== FLAGS ==")
    for f in red:
        print(f"  RED    {f}")
    for f in yel:
        print(f"  YELLOW {f}")
    for f in inf:
        print(f"  INFO   {f}")
    if not flags:
        print("  none")
    if not m and not flags:
        v = "NO DATA — not trading on any indexed DEX, or wrong address/chain"
    elif red:
        v = "AVOID — hard red flags"
    elif len(yel) >= 5:
        v = "HIGH RISK — many structural warnings"
    elif len(yel) >= 2:
        v = "SPECULATIVE — lottery-ticket sizing only"
    else:
        v = "STRUCTURALLY CLEAN — still a meme; narrative and timing decide"
    print(f"== VERDICT == {v}  ({len(red)} red, {len(yel)} yellow)")
    return v


# --------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("address")
    ap.add_argument("--chain", help="DexScreener chainId override (solana, robinhood, bsc, ethereum, base, arbitrum)")
    ap.add_argument("--json", action="store_true", help="emit machine-readable summary at the end")
    ap.add_argument("--full", action="store_true", help="longer holder/trader/candle tables")
    ap.add_argument("--no-chain", action="store_true", help="skip RPC log analysis (fast mode)")
    a = ap.parse_args()
    addr = a.address.strip()
    is_evm = addr.startswith("0x") and len(addr) == 42
    addr = addr.lower() if is_evm else addr
    t_start = time.time()
    flags = []
    print(f"# token_check {addr}  {ts(time.time())}")
    m = market(addr)
    if m:
        print_market(m)
    else:
        print("== MARKET ==\nno DexScreener pairs (not trading, or wrong address)")
    chain = a.chain or (m["chain"] if m else ("solana" if not is_evm else None))
    if not is_evm:
        solana_report(addr, flags, a.full)
    elif chain:
        evm_report(addr, chain, m, flags, a.full, not a.no_chain)
    else:
        print("cannot determine chain; pass --chain")
    candles(m, flags, a.full)
    v = verdict(m, flags)
    print(f"# done in {time.time()-t_start:.0f}s")
    if a.json:
        print(json.dumps({"address": addr, "chain": chain, "market": m, "flags": flags, "verdict": v}, default=str))


if __name__ == "__main__":
    main()
