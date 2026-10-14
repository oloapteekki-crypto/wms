// Inventointierot – reaaliaikainen näkymä tietokoneelle. Portattu inventointi.html:n ?view=erot -tilasta.
// Näyttää tämän päivän erot ja Maxxiin kirjattavan uuden saldon (Maxx → laskettu − keräämätön).
// Kirjaus MAXXiin tehdään käsin erillisellä työkalulla: "Siirretty" kuittaa eron.
import { createStore, todayKey } from "../../lib/store/index.js";
import { downloadCsv } from "../../lib/csv.js";
import { loginHtml, doLogin } from "../../lib/auth-ui.js";
import { esc, $ } from "../../lib/ui.js";
import { aisleIdx, productsFromSnapshot, klo } from "./domain.js";
import { fetchExport, loadFromFiles, saveSnapshot } from "./data.js";

const app = $("app");
const today = todayKey();
let store, user = null;
let counted = {}, productsRaw = {}, dismissed = {}, meta = null;
let status = null;
const unsubs = [];

const products = () => productsFromSnapshot(productsRaw);
const exp = (vnr) => (productsRaw[vnr]?.expected || 0);

function stats() {
  const devs = [];
  let dismissedCount = 0;
  for (const [vnr, c] of Object.entries(counted)) {
    const p = productsRaw[vnr] || {};
    const diff = c.qty - exp(vnr);
    if (diff === 0) continue;
    if (dismissed[vnr]) { dismissedCount++; continue; }
    if (c.date !== today) continue;
    const us = p.unshipped || 0;
    devs.push({ vnr, name: c.name || p.name || "?", location: c.location || p.location || "", expected: exp(vnr), counted: c.qty, diff, worker: c.worker || "", unshipped: us, maxx: c.qty - us });
  }
  devs.sort((a, b) => a.diff - b.diff);
  const shelves = {};
  for (const [vnr, p] of Object.entries(productsRaw)) {
    const parts = (p.location || "").split("-");
    if (parts.length < 3) continue;
    const key = parts[0] + "-" + parts[1];
    const s = (shelves[key] ||= { total: 0, counted: 0 });
    s.total++;
    if (counted[vnr]) s.counted++;
  }
  return { devs, dismissedCount, shelves };
}

function metaText() {
  if (!meta) return "";
  const parts = [];
  if (meta.loadedAt) parts.push("Haettu " + new Date(meta.loadedAt).toLocaleString("fi-FI"));
  if (meta.source) parts.push(meta.source);
  if (meta.count) parts.push(meta.count + " tuotetta");
  return parts.join(" • ");
}

function render() {
  if (store.auth.required && !user) { app.innerHTML = loginHtml(status?.error); return; }
  const { devs, dismissedCount, shelves } = stats();
  const keys = Object.keys(shelves).sort((a, b) => {
    const pa = a.split("-"), pb = b.split("-");
    const ai = aisleIdx(pa[0]), bi = aisleIdx(pb[0]);
    return ai !== bi ? ai - bi : pa[1].localeCompare(pb[1], undefined, { numeric: true });
  });
  const done = keys.filter((k) => shelves[k].counted === shelves[k].total && shelves[k].total > 0).length;
  const pct = keys.length ? Math.round((done / keys.length) * 100) : 0;
  const totalCounted = Object.keys(counted).length;
  const totalProducts = Object.keys(productsRaw).length;

  let h = `<a class="back" href="../../../index.html">← WMS</a>
    <div class="card"><h1>Inventointierot — Live</h1>
      <p class="sub">${today} — ${devs.length} eroa${dismissedCount ? " — ✓ " + dismissedCount + " kuitattu" : ""}</p>
      ${meta ? `<div class="meta">Odotetut saldot: ${esc(metaText())}</div>` : ""}
      ${totalProducts ? `<div style="margin-bottom:12px"><div class="flex justify-between" style="font-size:12px;color:#475569;margin-bottom:4px"><span>Hyllyt: ${done}/${keys.length}</span><span>${keys.length - done} jäljellä (${pct}%)</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div></div>` : ""}
      <div class="flex gap-8 mb-8"><button class="btn-sm btn-outline flex-1" data-action="dl-devs-all">Erot (kaikki)</button><button class="btn-sm btn-outline flex-1" data-action="dl-all">Kaikki</button></div>
      <div class="flex gap-8 mb-8"><button class="btn-sm btn-outline flex-1" data-action="dl-devs-today">Erot (tänään)</button><button class="btn-sm btn-outline flex-1" data-action="dl-today">Tänään</button></div>
      ${devs.length ? `<button class="btn-sm btn-ok" style="width:100%;margin-bottom:8px" data-action="dismiss-all">✓ Merkitse kaikki siirretyiksi</button>` : ""}
      ${dismissedCount ? `<details style="margin-bottom:8px"><summary style="font-size:12px;color:#16a34a;cursor:pointer">✓ Siirretty Maxxiin (${dismissedCount})</summary><div style="margin-top:4px">
        ${Object.entries(counted).filter(([vnr, c]) => c.qty !== exp(vnr) && dismissed[vnr]).map(([vnr, c]) => `<div style="padding:4px 8px;font-size:11px;color:#94a3b8;display:flex;justify-content:space-between;align-items:center"><span>${esc(c.name || productsRaw[vnr]?.name || vnr)} | Maxx→${c.qty - (productsRaw[vnr]?.unshipped || 0)}</span><button style="font-size:10px;padding:2px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;cursor:pointer" data-action="undismiss" data-vnr="${esc(vnr)}">Palauta</button></div>`).join("")}
      </div></details>` : ""}</div>
    <details class="card"><summary style="font-size:14px;font-weight:600;color:#288264;cursor:pointer">Päivitä odotetut saldot</summary><div style="margin-top:8px">
      <p style="font-size:12px;color:#64748b;margin-bottom:8px">Hakee tuoreen MAXX-saldon ja keräämättömät BigQuery-viennistä. Dataa haetaan vain kun painat nappia.</p>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px"><input type="checkbox" id="keep-counted" checked> Säilytä aiemmat inventointitulokset</label>
      <button class="btn" id="refresh-btn" data-action="refresh">🔄 Hae tuore data</button>
      <details style="margin-top:8px"><summary style="font-size:12px;color:#288264;cursor:pointer">Lataa tiedostoista (varakeino)</summary><div style="margin-top:8px">
        <div class="mb-8"><label class="label">Maxx saldo</label><input type="file" id="maxx-file" accept=".csv" style="font-size:13px;width:100%"></div>
        <div class="mb-8"><label class="label">Keräilemätön</label><input type="file" id="mag-file" accept=".csv" style="font-size:13px;width:100%"></div>
        <div class="mb-8"><label class="label">EAN (valinnainen)</label><input type="file" id="ean-file" accept=".csv" style="font-size:13px;width:100%"></div>
        <button class="btn" data-action="refresh-files">Lataa tiedostoista</button></div></details>
      ${status?.text ? `<div class="scan-result ${status.ok ? "scan-ok" : "scan-fail"}">${esc(status.text)}</div>` : ""}</div></details>`;

  if (keys.length) {
    h += `<details class="card"><summary style="font-size:14px;font-weight:600;color:#475569;cursor:pointer">Hyllyt (${done}/${keys.length})</summary><div class="shelf-grid small" style="margin-top:8px">
      ${keys.map((k) => {
        const s = shelves[k];
        const d = s.counted === s.total && s.total > 0;
        const started = s.counted > 0 && !d;
        const bg = d ? "#f0fdf4" : started ? "#fffbeb" : "#f8fafc";
        const bd = d ? "#86efac" : started ? "#fde68a" : "#e2e8f0";
        const col = d ? "#16a34a" : started ? "#92400e" : "#94a3b8";
        return `<div style="padding:6px;border-radius:6px;text-align:center;background:${bg};border:1px solid ${bd}"><div style="font-size:12px;font-weight:700;color:${col}">${esc(k)}</div><div style="font-size:10px;color:${col}">${s.counted}/${s.total}</div></div>`;
      }).join("")}</div></details>`;
  }

  if (devs.length) {
    h += devs.map((d) => `<div class="deviation ${d.diff > 0 ? "dev-plus" : "dev-minus"}">
      <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:12px">${esc(d.name)}</div><div class="mono" style="color:#64748b">${esc(d.location)} | VNR ${esc(d.vnr)}</div><div style="font-size:11px;color:#94a3b8">${esc(d.worker)}</div></div>
      <div style="text-align:right;white-space:nowrap;margin-left:8px"><div style="font-size:11px;color:#94a3b8">Hyllyssä: ${d.counted} | Odotettu: ${d.expected}</div>
        <div style="font-size:18px;font-weight:800;color:#1e5f49;margin:2px 0">Maxx → ${d.maxx}</div>
        <div style="font-size:10px;color:#94a3b8">${d.unshipped ? "Keräilemätön: " + d.unshipped : ""}</div>
        <button class="btn-ok" style="margin-top:4px;font-size:11px;padding:4px 12px;border-radius:6px;cursor:pointer;font-weight:600" data-action="dismiss" data-vnr="${esc(d.vnr)}">✓ Siirretty</button></div></div>`).join("");
  } else if (totalCounted > 0) h += `<div class="card" style="text-align:center;padding:24px"><div style="font-size:36px;margin-bottom:8px">✓</div><h2 style="color:#16a34a">Ei eroja</h2></div>`;
  else if (!totalProducts) h += `<div class="card" style="text-align:center;padding:24px;color:#94a3b8">Ei dataa — hae tuore data yltä</div>`;
  else h += `<div class="card" style="text-align:center;padding:24px;color:#94a3b8">Inventointia ei aloitettu</div>`;
  h += `<div style="text-align:center;margin-top:12px;font-size:11px;color:#94a3b8">Päivittyy automaattisesti kun sivu on auki</div>`;
  app.innerHTML = h;
}

const csvOpts = { bom: true, quoteAll: true };
const actions = {
  login: async () => { status = { error: await doLogin(store, $("login-email"), $("login-pass")) }; render(); },
  "dl-all": () => {
    const rows = [["VNR", "Nimi", "Paikka", "Odotettu", "Inventoitu", "Erotus", "Inventoija", "Päivä", "Klo"]];
    for (const [vnr, c] of Object.entries(counted).sort((a, b) => (a[1].t || 0) - (b[1].t || 0))) rows.push([vnr, c.name || productsRaw[vnr]?.name || "", c.location || productsRaw[vnr]?.location || "", exp(vnr), c.qty, c.qty - exp(vnr), c.worker || "", c.date || "", klo(c.t)]);
    downloadCsv("inventointi_kaikki.csv", rows, ",", csvOpts);
  },
  "dl-today": () => {
    const rows = [["VNR", "Nimi", "Paikka", "Odotettu", "Inventoitu", "Erotus", "Inventoija", "Klo"]];
    for (const [vnr, c] of Object.entries(counted).filter(([, c]) => c.date === today).sort((a, b) => (a[1].t || 0) - (b[1].t || 0))) rows.push([vnr, c.name || productsRaw[vnr]?.name || "", c.location || productsRaw[vnr]?.location || "", exp(vnr), c.qty, c.qty - exp(vnr), c.worker || "", klo(c.t)]);
    downloadCsv(`inventointi_${today}.csv`, rows, ",", csvOpts);
  },
  "dl-devs-all": () => {
    const rows = [["VNR", "Nimi", "Paikka", "Odotettu", "Inventoitu", "Erotus", "Inventoija", "Päivä", "Klo"]];
    for (const [vnr, c] of Object.entries(counted).filter(([v, c]) => c.qty !== exp(v) && !dismissed[v]).sort((a, b) => (a[1].t || 0) - (b[1].t || 0))) rows.push([vnr, c.name || productsRaw[vnr]?.name || "", c.location || productsRaw[vnr]?.location || "", exp(vnr), c.qty, c.qty - exp(vnr), c.worker || "", c.date || "", klo(c.t)]);
    downloadCsv("erot_kaikki.csv", rows, ",", csvOpts);
  },
  "dl-devs-today": () => {
    const rows = [["VNR", "Nimi", "Paikka", "Odotettu", "Inventoitu", "Erotus", "Inventoija", "Klo"]];
    for (const [vnr, c] of Object.entries(counted).filter(([v, c]) => c.date === today && c.qty !== exp(v)).sort((a, b) => (a[1].t || 0) - (b[1].t || 0))) rows.push([vnr, c.name || productsRaw[vnr]?.name || "", c.location || productsRaw[vnr]?.location || "", exp(vnr), c.qty, c.qty - exp(vnr), c.worker || "", klo(c.t)]);
    downloadCsv(`erot_${today}.csv`, rows, ",", csvOpts);
  },
  dismiss: (d) => store.set(`inventointi/dismissed/${d.vnr}`, { t: Date.now() }),
  undismiss: (d) => store.remove(`inventointi/dismissed/${d.vnr}`),
  "dismiss-all": () => {
    if (!confirm("Kuittaa kaikki erot?")) return;
    const upd = {};
    for (const [vnr, c] of Object.entries(counted)) if (c.qty !== exp(vnr)) upd[vnr] = { t: Date.now() };
    store.update("inventointi/dismissed", upd);
  },
  refresh: async () => {
    const keep = $("keep-counted")?.checked !== false;
    status = { text: "Haetaan dataa...", ok: true }; render();
    try {
      const data = await fetchExport();
      await saveSnapshot(store, data, { keepCounted: keep });
      status = { text: `✓ ${data.products.length} tuotetta päivitetty`, ok: true };
    } catch (e) { status = { text: "Haku epäonnistui: " + e.message, ok: false }; }
    render();
  },
  "refresh-files": async () => {
    const keep = $("keep-counted")?.checked !== false;
    const maxxFile = $("maxx-file")?.files[0], magFile = $("mag-file")?.files[0], eanFile = $("ean-file")?.files[0] || null;
    if (!maxxFile || !magFile) { status = { text: "Valitse Maxx-saldo ja keräilemätön", ok: false }; render(); return; }
    status = { text: "Luetaan tiedostoja...", ok: true }; render();
    try {
      const data = await loadFromFiles(store, { maxxFile, magFile, eanFile });
      await saveSnapshot(store, data, { keepCounted: keep });
      status = { text: `✓ ${data.products.length} tuotetta päivitetty`, ok: true };
    } catch (e) { status = { text: "Virhe: " + e.message, ok: false }; }
    render();
  },
};

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el.dataset, el);
});

function subscribeAll() {
  unsubs.splice(0).forEach((u) => u?.());
  unsubs.push(store.subscribe("inventointi/counted", (v) => { counted = v || {}; render(); }));
  unsubs.push(store.subscribe("inventointi/products", (v) => { productsRaw = v || {}; render(); }));
  unsubs.push(store.subscribe("inventointi/dismissed", (v) => { dismissed = v || {}; render(); }));
  unsubs.push(store.subscribe("inventointi/meta", (v) => { meta = v || null; render(); }));
}

async function init() {
  store = await createStore();
  store.auth.onChange((u) => {
    user = u;
    if (u) subscribeAll();
    render();
  });
  render();
}

init();
