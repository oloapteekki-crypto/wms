// Raportti: reaaliaikainen yhteenveto hyllytyksestä, purusta ja inventoinnista (tietokone).
// Tilaa Firebasen polut vain kun sivu on auki; päivä valitaan valitsimesta (oletus tänään).
import { createStore, todayKey } from "../../lib/store/index.js";
import { loginHtml, doLogin } from "../../lib/auth-ui.js";
import { esc, $ } from "../../lib/ui.js";
import {
  summarizeShelving, summarizeScanLog, summarizeUnloading, activeNow, summarizeInventory, summarizeTransfers, summarizeReceiving, fmtDuration, timeOf,
} from "./report.js";

const app = $("app");
let store, user = null;
let date = todayKey();
let receiving = {};
let session = null, scanLog = null, counted = {}, products = {}, dismissed = {}, invMeta = null;
let authError = null;
let unsubs = [];
let invUnsubs = [];
let renderTimer = null;

const fmt = new Intl.NumberFormat("fi-FI", { maximumFractionDigits: 1 });
const pct = (x) => (x === null || x === undefined ? "–" : Math.round(x * 100) + " %");
const num = (x) => (x === null || x === undefined ? "–" : fmt.format(x));

function tile(label, value, sub = "") {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ""}</div>`;
}

/* ───────── Kaavio: kpl/tunti (yksi sarja, yksi sävy, tangot kiinni peruslinjassa) ───────── */
function hourlyChart(hourly) {
  if (!hourly.length) return `<div class="empty">Ei hyllytyksiä vielä tänä päivänä</div>`;
  const W = 640, H = 190, L = 40, R = 8, T = 10, B = 24;
  const max = Math.max(...hourly.map((h) => h.units));
  const niceMax = max <= 10 ? 10 : Math.ceil(max / 10) * 10;
  const plotW = W - L - R, plotH = H - T - B;
  const slot = plotW / hourly.length;
  const bw = Math.max(6, Math.min(36, slot - 6)); // ohut tanko + väli
  const y = (v) => T + plotH - (v / niceMax) * plotH;
  const ticks = [0, niceMax / 2, niceMax];
  const bars = hourly.map((h, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    const top = y(h.units);
    const hgt = T + plotH - top;
    const r = Math.min(4, bw / 2, hgt);
    // pyöristetty vain data-pää (ylä), pohja suora
    const path = hgt > 0 ? `M${x},${T + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${T + plotH} Z` : "";
    return `<g class="bar" data-hour="${h.hour}" data-units="${h.units}">
      <rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${plotH}" fill="transparent"/>
      <path d="${path}" class="mark"/>
      <text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle" class="axis">${h.hour}</text></g>`;
  }).join("");
  const grid = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" class="axis">${t}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Hyllytetyt kappaleet tunneittain">${grid}${bars}</svg>
    <details class="tableview"><summary>Taulukkonäkymä</summary><table><thead><tr><th>Tunti</th><th class="r">Kpl</th></tr></thead><tbody>
      ${hourly.map((h) => `<tr><td>${h.hour}–${h.hour + 1}</td><td class="r">${h.units}</td></tr>`).join("")}</tbody></table></details>`;
}

/* ───────── Näkymä ───────── */
function render() {
  if (store.auth.required && !user) { app.innerHTML = loginHtml(authError); return; }
  const now = Date.now();
  const shelving = summarizeShelving(session?.performance);
  const log = summarizeScanLog(scanLog);
  const unload = summarizeUnloading(session);
  const active = activeNow(session, now);
  const inv = summarizeInventory(counted, products, dismissed, date);
  const transfers = summarizeTransfers(session?.siirrot, now);
  const recv = summarizeReceiving(receiving, date, now);
  const hasData = shelving.batchCount + shelving.interruptedCount + log.events + unload.boxes + inv.countedToday + transfers.total + recv.rows.length > 0;
  const isToday = date === todayKey();

  const closed = Object.entries(unload.closedBatches).map(([c, n]) => `${esc(c)}: ${n}`).join(", ") || "–";

  app.innerHTML = `
    <a class="back" href="../../../index.html">← WMS</a>
    <div class="head"><div><h1>📊 Raportti</h1><div class="sub">${isToday ? '<span class="live"></span>Päivittyy reaaliajassa' : "Valittu päivä (ei kuluva)"}</div></div>
      <label class="datepick">Päivä <input type="date" id="date" value="${esc(date)}"></label></div>
    ${store.kind === "local" ? `<div class="mode-banner">⚠ Paikallinen tila: näkyy vain tämän laitteen data.</div>` : ""}

    <h2>Hyllytys</h2>
    <div class="tiles">
      ${tile("Luetut laatikot", unload.boxes, `${unload.unitsInBoxes} kpl`)}
      ${tile("Valmiita kärryeriä", shelving.batchCount, shelving.interruptedCount ? `${shelving.interruptedCount} keskeytynyttä` : "ei keskeytyneitä")}
      ${tile("Hyllytetty", `${shelving.shelved} <span class="of">/ ${shelving.expected}</span>`, "kpl / odotettu")}
      ${tile("Tarkkuus", pct(shelving.accuracy), "hyllytetty / odotettu")}
      ${tile("Nopeus", num(shelving.rate), "kpl / min (erien aika)")}
    </div>

    <div class="grid2">
      <div class="card"><h3>Hyllytetyt kappaleet tunneittain</h3>${hourlyChart(log.hourly)}</div>
      <div class="card"><h3>Käynnissä nyt</h3>
        ${isToday && active.length ? `<table><thead><tr><th>Kärry</th><th class="r">Hyllytetty</th><th class="r">Viimeksi</th></tr></thead><tbody>
          ${active.map((a) => `<tr class="${a.stale ? "stale" : ""}"><td>${esc(a.cart)}${a.stale ? ' <span class="chip">jumissa?</span>' : ""}</td><td class="r">${a.units} kpl</td><td class="r">${a.ageMin} min sitten</td></tr>`).join("")}</tbody></table>`
          : `<div class="empty">${isToday ? "Ei käynnissä olevia hyllytyksiä" : "Vain kuluvalle päivälle"}</div>`}
        <div class="small muted">Suljetut kärryerät: ${closed}</div>
        <div class="small muted">Syöttötapa: skannaus ${log.methods.scan}, puhe ${log.methods.voice}, käsin ${log.methods.manual}</div></div>
    </div>

    <div class="card"><h3>Hyllyttäjät</h3>
      ${shelving.byWorker.length ? `<table><thead><tr><th>Työntekijä</th><th class="r">Erät</th><th class="r">Kpl</th><th class="r">Odotettu</th><th class="r">Aika</th><th class="r">Kpl/min</th><th class="r">Tarkkuus</th></tr></thead><tbody>
        ${shelving.byWorker.map((w) => `<tr><td>${esc(w.worker)}${w.interrupted ? ` <span class="chip">${w.interrupted} kesk.</span>` : ""}</td><td class="r">${w.batches}</td><td class="r">${w.shelved}</td><td class="r">${w.expected}</td><td class="r">${fmtDuration(w.ms)}</td><td class="r">${num(w.rate)}</td><td class="r">${pct(w.accuracy)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Ei hyllytyksiä</div>`}</div>

    <div class="card"><h3>Hyllytyserät</h3>
      ${shelving.batches.length ? `<table><thead><tr><th>Klo</th><th>Työntekijä</th><th>Kärry</th><th class="r">Hyllytetty</th><th class="r">Aika</th><th class="r">Kpl/min</th></tr></thead><tbody>
        ${shelving.batches.map((b) => `<tr><td>${timeOf(b.end)}</td><td>${esc(b.worker)}</td><td>${esc(b.cartName || b.cart)}</td><td class="r ${b.shelved < b.expected ? "short" : ""}">${b.shelved} / ${b.expected}</td><td class="r">${fmtDuration(b.elapsed)}</td><td class="r">${num(b.rate)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Ei valmiita eriä</div>`}</div>

    <h2>Inventointi</h2>
    <div class="tiles">
      ${tile("Inventoitu tänään", inv.countedToday, "tuotetta")}
      ${tile("Eroja (kuittaamatta)", inv.deviations, `${inv.absUnits} kpl yhteensä`)}
      ${tile("Kuitattu", inv.dismissedToday, "siirretty MAXXiin")}
      ${tile("Hyllyt valmiina", `${inv.shelvesDone} <span class="of">/ ${inv.shelvesTotal}</span>`, invMeta?.loadedAt ? "saldot " + new Date(invMeta.loadedAt).toLocaleString("fi-FI") : "")}
    </div>
    <div class="card"><h3>Inventoijat</h3>
      ${inv.byWorker.length ? `<table><thead><tr><th>Työntekijä</th><th class="r">Tuotteita</th></tr></thead><tbody>${inv.byWorker.map((w) => `<tr><td>${esc(w.worker)}</td><td class="r">${w.n}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Ei inventointeja</div>`}
      <div class="small"><a href="../inventointi/erot.html">Avaa erolista →</a></div></div>

    <h2>Toimittajatilausten vastaanotto</h2>
    <div class="tiles">
      ${tile("Valmiita tilauksia", recv.doneCount, `${recv.progressCount} kesken`)}
      ${tile("Odottaa purkua", recv.waitingCount, recv.longestWaitMs !== null ? `pisin ${fmtDuration(recv.longestWaitMs)}` : "ei odottavia")}
      ${tile("Keskim. purkuaika", recv.avgDurationMs !== null ? fmtDuration(recv.avgDurationMs) : "–", "aloituksesta valmistumiseen")}
      ${tile("Keskim. työaika", recv.avgWorkMs !== null ? fmtDuration(recv.avgWorkMs) : "–", "ilman taukoja (yli 10 min)")}
      ${tile("Keskim. odotus", recv.avgWaitMs !== null ? fmtDuration(recv.avgWaitMs) : "–", "saapumisesta purun alkuun")}
    </div>
    <div class="card"><h3>Tilaukset</h3>
      ${recv.rows.length ? `<table><thead><tr><th>Toimittaja</th><th>Tila</th><th>Saapui</th><th>Purku alkoi</th><th>Valmis</th><th class="r">Odotus</th><th class="r">Kesto</th><th class="r">Työaika</th><th class="r">Kpl</th><th>Purkajat</th></tr></thead><tbody>
        ${recv.rows.map((x) => `<tr><td>${esc(x.supplier)}</td><td>${x.status === "done" ? "valmis" : x.status === "progress" ? "kesken" : `<span class="chip">odottaa</span>`}</td><td>${x.arrival ? timeOf(x.arrival) : "–"}</td><td>${x.started ? timeOf(x.started) : "–"}</td><td>${x.completion ? timeOf(x.completion) : "–"}</td><td class="r">${x.waitMs !== null ? fmtDuration(x.waitMs) : "–"}</td><td class="r">${x.durationMs !== null ? fmtDuration(x.durationMs) : "–"}</td><td class="r">${x.workMs !== null ? fmtDuration(x.workMs) : "–"}</td><td class="r">${x.received} / ${x.ordered}</td><td>${esc(x.workers.join(", "))}</td></tr>`).join("")}</tbody></table>
        <div class="small muted">Saapumisaika merkitään Vastaanotossa painikkeella "Merkitse saapuneeksi varastolle". Odotus = saapumisesta purun alkuun, kesto = purun alusta valmistumiseen, työaika ilman yli 10 min taukoja.</div>` : `<div class="empty">Ei vastaanotettuja tilauksia tälle päivälle</div>`}</div>

    <h2>Siirrot</h2>
    <div class="tiles">
      ${tile("Hyllytetty uusille paikoille", transfers.placed, "siirtoa valmiina")}
      ${tile("Kerätty, ei vielä hyllytetty", transfers.picked, "kärryissä")}
      ${tile("Varattu", transfers.claimed, "ei vielä kerätty")}
      ${tile("Ohitettu", transfers.skipped, "siirtoa")}
    </div>
    <div class="card"><h3>Siirtäjät</h3>
      ${transfers.byWorker.length ? `<table><thead><tr><th>Työntekijä</th><th class="r">Hyllytetty</th><th class="r">Kerätty</th><th class="r">Varattu</th><th class="r">Ohitettu</th></tr></thead><tbody>
        ${transfers.byWorker.map((w) => `<tr><td>${esc(w.worker)}</td><td class="r">${w.placed}</td><td class="r">${w.picked}</td><td class="r">${w.claimed}</td><td class="r">${w.skipped}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Ei siirtoja</div>`}
      ${transfers.recent.length ? `<h3 style="margin-top:12px">Viimeisimmät siirrot</h3><table><thead><tr><th>Klo</th><th>Työntekijä</th><th>Tuote</th><th>Mistä</th><th>Mihin</th><th>Tila</th></tr></thead><tbody>
        ${transfers.recent.map((e) => `<tr><td>${timeOf(e.t)}</td><td>${esc(e.worker)}</td><td class="mono">${esc(e.sku)}</td><td class="mono">${esc(e.from)}</td><td class="mono">${esc(e.to)}</td><td>${e.state === "placed" ? "hyllytetty" : "kerätty"}</td></tr>`).join("")}</tbody></table>` : ""}</div>

    <div class="card"><h3>Viimeisimmät hyllytykset</h3>
      ${log.recent.length ? `<table><thead><tr><th>Klo</th><th>Työntekijä</th><th>Tuote</th><th>Paikka</th><th class="r">+</th><th class="r">Yht.</th></tr></thead><tbody>
        ${log.recent.map((e) => `<tr><td>${timeOf(e.t)}</td><td>${esc(e.worker)}</td><td>${esc(e.name)}</td><td class="mono">${esc(e.location)}</td><td class="r">${e.added > 0 ? "+" : ""}${e.added}</td><td class="r">${e.total}/${e.expected}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Ei tapahtumia</div>`}</div>
    ${hasData ? "" : `<div class="card empty">Ei dataa valitulle päivälle.</div>`}
    <div class="small muted foot">Dimensiot tallentaa vain laitteelle, joten se ei näy raportissa.</div>
    <div id="tip" class="tip" hidden></div>`;
}

// Useat tilaukset päivittyvät peräkkäin: piirretään enintään kerran sekunnissa.
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 250);
}

function subscribeDay() {
  unsubs.splice(0).forEach((u) => u?.());
  session = null; scanLog = null;
  unsubs.push(store.subscribe(`sessions/${date}`, (v) => { session = v; scheduleRender(); }));
  unsubs.push(store.subscribe(`scanLog/${date}`, (v) => { scanLog = v; scheduleRender(); }));
  unsubs.push(store.subscribe("vastaanotto", (v) => { receiving = v || {}; scheduleRender(); }));
}

function subscribeInventory() {
  invUnsubs.splice(0).forEach((u) => u?.());
  invUnsubs.push(store.subscribe("inventointi/counted", (v) => { counted = v || {}; scheduleRender(); }));
  invUnsubs.push(store.subscribe("inventointi/products", (v) => { products = v || {}; scheduleRender(); }));
  invUnsubs.push(store.subscribe("inventointi/dismissed", (v) => { dismissed = v || {}; scheduleRender(); }));
  invUnsubs.push(store.subscribe("inventointi/meta", (v) => { invMeta = v || null; scheduleRender(); }));
}

/* ───────── Tapahtumat ───────── */
app.addEventListener("click", async (e) => {
  if (e.target.closest("[data-action=login]")) { authError = await doLogin(store, $("login-email"), $("login-pass")); render(); }
});
app.addEventListener("change", (e) => {
  if (e.target.id === "date" && e.target.value) { date = e.target.value; subscribeDay(); render(); }
});

// Kaavion vihje (hover): per tanko
app.addEventListener("mousemove", (e) => {
  const bar = e.target.closest?.(".bar");
  const tip = $("tip");
  if (!tip) return;
  if (!bar) { tip.hidden = true; return; }
  const h = Number(bar.dataset.hour);
  tip.textContent = `${h}–${h + 1}: ${bar.dataset.units} kpl`;
  tip.hidden = false;
  tip.style.left = e.clientX + 12 + "px";
  tip.style.top = e.clientY - 28 + "px";
});

async function init() {
  store = await createStore();
  store.auth.onChange((u) => {
    user = u;
    if (u) { subscribeDay(); subscribeInventory(); }
    render();
  });
  setInterval(() => { if (user || !store.auth.required) render(); }, 30000); // päivittää "x min sitten"
  render();
}

init();
