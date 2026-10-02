const SERVER = "http://127.0.0.1:8787";
const $ = (id) => document.getElementById(id);

const state = { ca: null, chain: "solana", tabId: null, timers: [], plan: null, live: null, lastCands: "" };

const fmtM = (v) => {
  if (v == null || isNaN(v)) return "-";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};
const fmtAge = (h) => (h == null ? "-" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);

async function api(path) {
  const r = await fetch(`${SERVER}${path}`);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

function setStatus(text, bad = false) {
  $("status").textContent = text;
  $("status").style.color = bad ? "#fca5a5" : "";
}

function badge(el, text, cls) {
  el.textContent = text;
  el.className = `badge ${cls || ""}`;
}

function verdictClass(v) {
  if (!v) return "";
  if (v.startsWith("AVOID") || v === "RUG") return "red";
  if (v.startsWith("HIGH") || v === "WATCH" || v.startsWith("SPECULATIVE")) return "yellow";
  if (v.startsWith("STRUCTURALLY") || v === "DIP") return "green";
  return "blue";
}

// --------------------------------------------------------------------------- load / detect

async function resolveCandidates(cands) {
  for (const c of cands) {
    try {
      const r = await api(`/resolve?q=${encodeURIComponent(c)}`);
      if (r.address) return r;
    } catch (_) {
      return null;
    }
  }
  return null;
}

async function pickFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  state.tabId = tab.id;
  const got = await chrome.storage.session.get(`cands:${tab.id}`);
  const entry = got[`cands:${tab.id}`];
  if (!entry || !entry.candidates?.length) return;
  const key = entry.candidates.join(",");
  if (key === state.lastCands) return;
  state.lastCands = key;
  const r = await resolveCandidates(entry.candidates);
  if (r && r.address !== state.ca) load(r.address, r.chain);
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (state.tabId != null && changes[`cands:${state.tabId}`]) pickFromTab();
});
chrome.tabs.onActivated.addListener(() => { state.lastCands = ""; pickFromTab(); });

$("go").addEventListener("click", async () => {
  const q = $("ca").value.trim();
  if (!q) return;
  setStatus("resolving…");
  const r = await resolveCandidates([q]);
  if (!r) return setStatus("not an indexed token/pair address", true);
  load(r.address, r.chain);
});
$("ca").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });

function clearTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

async function load(ca, chain) {
  clearTimers();
  state.ca = ca;
  state.chain = chain || "solana";
  state.plan = null;
  $("ca").value = ca;
  $("main").classList.remove("hidden");
  $("report").classList.add("hidden");
  $("report").textContent = "";
  $("flags").innerHTML = "";
  badge($("verdict"), "checking…", "blue");
  setStatus(`${ca.slice(0, 6)}…${ca.slice(-4)} on ${state.chain}`);
  refreshLive();
  refreshRug();
  refreshPlan();
  refreshCheck();
  state.timers.push(setInterval(refreshLive, 10_000));
  state.timers.push(setInterval(refreshRug, 30_000));
  state.timers.push(setInterval(refreshPlan, 60_000));
}

// --------------------------------------------------------------------------- live

async function refreshLive() {
  if (!state.ca) return;
  try {
    const d = await api(`/live?ca=${state.ca}&chain=${state.chain}`);
    if (d.error) return setStatus(d.error, true);
    state.live = d;
    const m = d.market;
    $("name").textContent = `${m.name} (${m.symbol})`;
    $("meta").textContent = `${m.dex} · ${m.pools} pools · m5 ${m.chg.m5 ?? "-"}% · h1 ${m.chg.h1 ?? "-"}%`;
    $("mcap").textContent = fmtM(m.mcap);
    $("liq").textContent = `${fmtM(m.liq)} (${m.mcap ? ((100 * m.liq) / m.mcap).toFixed(0) : "-"}%)`;
    $("bs").textContent = `${d.buys5}/${d.sells5}`;
    $("txm").textContent = d.tx_per_min.toFixed(0);
    $("rng").textContent = d.median_range_pct == null ? "-" : `${d.median_range_pct.toFixed(0)}%`;
    $("rng").className = `v ${d.median_range_pct >= 25 ? "red" : ""}`;
    $("age").textContent = fmtAge(m.age_h);
    $("div").classList.toggle("hidden", !d.divergence);
    if (d.divergence) $("div").textContent = `Volume divergence: ${d.divergence}. Top signal on a parabola.`;
    drawSpark(d.candles, state.plan?.stop_mcap);
    const rows = d.big_trades.slice(0, 12).map((t) =>
      `<tr><td class="muted">${t.t}</td><td class="${t.kind}">${t.kind}</td><td>$${t.usd.toLocaleString()}</td><td class="muted">${t.wallet}</td><td class="bot">${t.bot || ""}</td></tr>`);
    $("trades").innerHTML = rows.join("") || `<tr><td class="muted">no trades over $2K recently</td></tr>`;
  } catch (e) {
    setStatus(`server unreachable: run python3 copilot/server/copilot_server.py (${e.message})`, true);
  }
}

function drawSpark(cs, stop) {
  const cv = $("spark");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!cs || !cs.length) return;
  const lows = cs.map((c) => c.l), highs = cs.map((c) => c.h);
  let lo = Math.min(...lows), hi = Math.max(...highs);
  if (stop) lo = Math.min(lo, stop);
  const pad = (hi - lo) * 0.05 || 1;
  lo -= pad; hi += pad;
  const vmax = Math.max(...cs.map((c) => c.v)) || 1;
  const n = cs.length, bw = W / n;
  const y = (p) => H - ((p - lo) / (hi - lo)) * (H - 22) - 20;
  cs.forEach((c, i) => {
    const x = i * bw;
    ctx.fillStyle = c.c >= c.o ? "rgba(34,197,94,.35)" : "rgba(239,68,68,.35)";
    const vh = (c.v / vmax) * 18;
    ctx.fillRect(x + 1, H - vh, Math.max(bw - 2, 1), vh);
    ctx.strokeStyle = c.c >= c.o ? "#22c55e" : "#ef4444";
    ctx.beginPath(); ctx.moveTo(x + bw / 2, y(c.h)); ctx.lineTo(x + bw / 2, y(c.l)); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
    ctx.fillRect(x + 1, top, Math.max(bw - 2, 1), Math.max(bot - top, 1));
  });
  if (stop) {
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#f59e0b";
    ctx.beginPath(); ctx.moveTo(0, y(stop)); ctx.lineTo(W, y(stop)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#f59e0b"; ctx.font = "10px sans-serif";
    ctx.fillText(`stop ${fmtM(stop)}`, 4, y(stop) - 3);
  }
  ctx.fillStyle = "#8a93a6"; ctx.font = "10px sans-serif";
  ctx.fillText(fmtM(hi - pad), 4, 10);
  ctx.fillText(fmtM(lo + pad), 4, H - 24);
}

// --------------------------------------------------------------------------- rug

async function refreshRug() {
  if (!state.ca) return;
  try {
    const d = await api(`/rug?ca=${state.ca}&chain=${state.chain}`);
    badge($("rugv"), d.verdict, verdictClass(d.verdict));
    $("rugaction").textContent = d.action || "";
    $("rugev").innerHTML = (d.evidence || []).map((e) => `<li class="${e.level}">${e.text}</li>`).join("");
  } catch (_) { /* status already shown by live */ }
}

// --------------------------------------------------------------------------- plan

async function refreshPlan() {
  if (!state.ca) return;
  const entry = $("entry").value, size = $("size").value, sol = $("solusd").value;
  let qs = `/plan?ca=${state.ca}&chain=${state.chain}`;
  if (entry) qs += `&entry=${entry}`;
  if (size) qs += `&size_sol=${size}`;
  if (sol) qs += `&sol_usd=${sol}`;
  try {
    const d = await api(qs);
    if (d.error) return;
    state.plan = d;
    badge($("book"), `${d.book} book`, d.book === "THESIS" ? "yellow" : "blue");
    $("low").textContent = fmtM(d.last_low_mcap);
    $("stop").textContent = `${fmtM(d.stop_mcap)} (${d.stop_pct_below?.toFixed(0)}% below · ${d.stop_buffer_pct?.toFixed(0)}% buffer)`;
    $("maxsize").textContent = fmtM(d.max_size_usd_for_10pct_impact);
    $("impact").textContent = d.exit_impact_pct == null ? "enter size" : `~${d.exit_impact_pct.toFixed(0)}%`;
    $("impact").className = `v ${d.exit_impact_pct > 15 ? "red" : ""}`;
    $("ladder").innerHTML = d.ladder.map((l) => `<li><b>${fmtM(l.mcap)}</b> — ${l.label}</li>`).join("");
    $("notes").innerHTML = d.notes.map((n) => `<li class="YELLOW">${n}</li>`).join("");
    if (d.book === "THESIS") {
      $("handsoff").classList.remove("hidden");
      $("handsoff").textContent = "Thesis book: no stop, no sell button for 24h unless Rug-or-dip says RUG. Size $300–500, written off at entry.";
    } else {
      $("handsoff").classList.add("hidden");
    }
    if (state.live) drawSpark(state.live.candles, d.stop_mcap);
  } catch (_) { /* ignore */ }
}
$("refreshplan").addEventListener("click", refreshPlan);
for (const id of ["entry", "size", "solusd"]) {
  $(id).addEventListener("change", refreshPlan);
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") refreshPlan(); });
}

$("watch").addEventListener("click", async () => {
  if (!state.ca || !state.plan) return;
  const p = state.plan;
  const body = {
    ca: state.ca, chain: state.chain, name: p.market.name, entry_mcap: p.entry_mcap, book: p.book,
    stop_mcap: p.book === "MAIN" ? p.stop_mcap : null,
    target_mcap: p.entry_mcap * 2,
    hands_off_until: p.book === "THESIS" ? p.hands_off_until : null,
    size_sol: $("size").value ? parseFloat($("size").value) : null,
  };
  await fetch(`${SERVER}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  refreshWatch();
});

// --------------------------------------------------------------------------- check (token-check skill)

async function refreshCheck() {
  if (!state.ca) return;
  const ca = state.ca;
  try {
    const d = await api(`/check?ca=${ca}&chain=${state.chain}`);
    if (state.ca !== ca) return;
    badge($("verdict"), d.verdict || "no verdict", verdictClass(d.verdict));
    $("flags").innerHTML = (d.flags || []).map(([lvl, txt]) => `<li class="${lvl}">${txt}</li>`).join("") || `<li class="OK">no flags</li>`;
    $("report").textContent = d.report || "";
  } catch (_) {
    badge($("verdict"), "check failed", "red");
  }
}
$("togglereport").addEventListener("click", () => $("report").classList.toggle("hidden"));

// --------------------------------------------------------------------------- watchlist

async function refreshWatch() {
  try {
    const d = await api("/watch");
    const items = d.items || [];
    if (!items.length) { $("watchitems").innerHTML = "nothing watched"; return; }
    $("watchitems").innerHTML = items.map((it) => {
      const dist = it.stop_mcap && it.mcap ? (100 * (it.mcap / it.stop_mcap - 1)).toFixed(0) : null;
      const ho = it.hands_off_until ? Math.max(0, (it.hands_off_until * 1000 - Date.now()) / 3.6e6) : null;
      let sub;
      if (it.book === "THESIS") {
        sub = it.hands_off_fired ? "thesis · hands-off period over: run Rug-or-dip, then decide" : `thesis · hands off ${ho != null ? ho.toFixed(1) + "h left" : ""}`;
      } else if (it.stop_fired) {
        sub = `STOP HIT ${fmtM(it.stop_mcap)} — if you still hold, that is a decision you already made not to make`;
      } else if (it.target_fired) {
        sub = `TARGET HIT ${fmtM(it.target_mcap)} — principal out? stop ${fmtM(it.stop_mcap)} (${dist}% away)`;
      } else {
        sub = `stop ${fmtM(it.stop_mcap)} (${dist}% away) · target ${fmtM(it.target_mcap)}`;
      }
      const cls = it.stop_fired ? "hit" : dist != null && dist < 8 ? "near" : "";
      return `<div class="witem"><div><div><b>${it.name || it.ca.slice(0, 8)}</b> ${fmtM(it.mcap)}</div><div class="sub ${cls}">${sub}</div></div>
        <button data-ca="${it.ca}" data-chain="${it.chain || "solana"}" class="open">open</button><button data-ca="${it.ca}" class="rm">x</button></div>`;
    }).join("");
    $("watchitems").querySelectorAll(".open").forEach((b) => b.addEventListener("click", () => load(b.dataset.ca, b.dataset.chain)));
    $("watchitems").querySelectorAll(".rm").forEach((b) => b.addEventListener("click", async () => {
      await fetch(`${SERVER}/watch?ca=${b.dataset.ca}`, { method: "DELETE" });
      refreshWatch();
    }));
  } catch (_) { /* ignore */ }
}

// --------------------------------------------------------------------------- boot

(async () => {
  try {
    await api("/health");
    setStatus("server ok · open a token page or paste a CA");
  } catch (_) {
    setStatus("server not running: python3 copilot/server/copilot_server.py", true);
  }
  refreshWatch();
  setInterval(refreshWatch, 30_000);
  pickFromTab();
})();
