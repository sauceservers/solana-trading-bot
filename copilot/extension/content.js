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
    // Generic: any address-shaped path segment or query value (Axiom, fomo and friends change routes).
    const g = href.match(new RegExp(`[/=](${B58}|${EVM})(?=[/?&#]|$)`));
    return g && !SKIP.has(g[1]) ? g[1] : null;
  }

  function tally(counts, a, w) {
    if (SKIP.has(a)) return;
    counts.set(a, (counts.get(a) || 0) + w + (a.endsWith("pump") ? 2 : 0));
  }

  // Terminals that truncate the CA on screen still carry the full mint in logo URLs, explorer links
  // and framework props, so scan markup too, not just visible text.
  function fromPage() {
    const counts = new Map();
    const re = new RegExp(`(${B58}|${EVM})`, "g");
    const text = (document.body && document.body.innerText) || "";
    let m, n = 0;
    while ((m = re.exec(text)) && n++ < 5000) tally(counts, m[1], 3);
    for (const a of document.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href") || "";
      if (/solscan|dexscreener|pump\.fun|birdeye|rugcheck|geckoterminal|solana\.fm|explorer\.solana/.test(h)) {
        const mm = h.match(re);
        if (mm) tally(counts, mm[0], 4);
      }
    }
    const html = document.documentElement.outerHTML.slice(0, 2_000_000);
    n = 0;
    while ((m = re.exec(html)) && n++ < 20000) tally(counts, m[1], 1);
    return [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map((e) => e[0]);
  }

  let last = "";
  function scan() {
    const url = fromUrl(location.href);
    const cands = url ? [url, ...fromPage().filter((c) => c !== url)] : fromPage();
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
