// Finds the token on the current page and hands candidates to the side panel.
// URL patterns first (exact), then a frequency scan of the page text (fuzzy).
(() => {
  const B58 = "[1-9A-HJ-NP-Za-km-z]{32,44}";
  const EVM = "0x[0-9a-fA-F]{40}";
  const ANY = `(${B58}|${EVM})`;
  const URL_PATTERNS = [
    new RegExp(`pump\\.fun/coin/(${B58})`),
    new RegExp(`axiom\\.trade/meme/(${B58})`),
    new RegExp(`dexscreener\\.com/[a-z]+/${ANY}`),
    new RegExp(`gmgn\\.ai/[a-z]+/token/(?:[^/]+_)?${ANY}`),
    new RegExp(`photon-sol\\.tinyastro\\.io/[a-z]{2}/lp/(${B58})`),
    new RegExp(`birdeye\\.so/token/${ANY}`),
    new RegExp(`solscan\\.io/token/(${B58})`),
    new RegExp(`geckoterminal\\.com/[a-z-]+/pools/${ANY}`),
    new RegExp(`bullx\\.io/terminal\\?.*?address=${ANY}`),
    new RegExp(`padre\\.gg/trade/[a-z]+/${ANY}`),
    new RegExp(`rugcheck\\.xyz/tokens/(${B58})`),
  ];
  const SKIP = new Set([
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM5HdxE5a9X3qpmEipuLnR7Fuaj2K",
    "Es9vMFrzaCERmJfrF6H2kmPvBBqNLnTiZRMYWfvWXuhc",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "ComputeBudget111111111111111111111111111111",
    "11111111111111111111111111111111",
  ]);

  function fromUrl(href) {
    for (const re of URL_PATTERNS) {
      const m = href.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  function fromText() {
    const text = (document.body && document.body.innerText) || "";
    const re = new RegExp(`\\b(${B58}|${EVM})\\b`, "g");
    const counts = new Map();
    let m;
    let n = 0;
    while ((m = re.exec(text)) && n++ < 5000) {
      const a = m[1];
      if (SKIP.has(a)) continue;
      counts.set(a, (counts.get(a) || 0) + (a.endsWith("pump") ? 3 : 1));
    }
    return [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map((e) => e[0]);
  }

  let last = "";
  function scan() {
    const url = fromUrl(location.href);
    const cands = url ? [url, ...fromText().filter((c) => c !== url)] : fromText();
    const key = cands.join(",");
    if (!cands.length || key === last) return;
    last = key;
    try {
      chrome.runtime.sendMessage({ type: "copilot:candidates", candidates: cands, href: location.href });
    } catch (_) {
      /* extension reloaded; page script is stale */
    }
  }

  scan();
  let href = location.href;
  setInterval(() => {
    if (location.href !== href) {
      href = location.href;
      last = "";
      setTimeout(scan, 800);
    }
  }, 500);
  setInterval(scan, 5000);
})();
