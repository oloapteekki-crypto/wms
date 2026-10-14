// Vastaanotto: toimittajatilausten purku. Korvaa Tilaukset-Sheetin vastaanotto-välilehden ja XML-skriptin.
// Tila tallentuu Firebaseen (vastaanotto/{tilaus}); useampi laite voi vastaanottaa samaa tilausta.
// Dataa (hyllypaikat) haetaan vain kun kärryjako tarvitaan.
import { createStore, todayKey } from "../../lib/store/index.js";
import { createCamera, cameraSupported } from "../../lib/camera.js";
import { listenText, parseSpokenNumber, speechSupported } from "../../lib/speech.js";
import { parseSpokenDate, formatYmd } from "../../lib/spoken.js";
import { readXlsx } from "../../lib/xlsx.js";
import { fetchCsvText, downloadCsv } from "../../lib/csv.js";
import { loadJson, saveJson } from "../../lib/storage.js";
import { loginHtml, doLogin } from "../../lib/auth-ui.js";
import { $ } from "../../lib/ui.js";
import { WORKERS } from "../../config/workers.js";
import { parseMaster, eanMatches, boxKey } from "../hyllytys/domain.js";
import { parseOrderWorkbook, lineKey, lineStatus, buildXml, xmlFileName, splitToCarts } from "./domain.js";
import { startView, orderView, deviationRows } from "./views.js";

const GCS_CSV = "https://storage.googleapis.com/olo-export-data/hyllytys-app-export000000000000.csv";
const YES = ["oikein", "kyllä", "joo", "jep", "ok", "okei"];
const NO = ["väärin", "ei", "uudelleen", "uusiksi"];
const app = $("app");

let store, user = null, camera = null;
let currentWorker = loadJson("wms_worker", "");
let scanAdds = loadJson("wms_vastaanotto_scanadds", false);
let recent = [];
let unsub = null;
let voice = null; // {key, mode, pending, handle}
let renderTimer = null;

let S = {
  phase: "start", order: null, recs: {}, tab: "lines", filter: "open", selectedKey: null, error: null, result: null, loading: null,
  master: null, masterError: null, masterLoading: false, voiceCandidate: null, voiceText: null, shelvingSentAt: null, xmlAt: null,
};

/* ───────── Render (säilyttää kentän fokuksen) ───────── */
function viewModel() {
  return {
    S, workers: WORKERS, currentWorker, storeKind: store.kind, recent, voiceOn: !!voice, scanAdds,
    camOk: cameraSupported(), camOn: !!camera?.running, dirOk: typeof window.showDirectoryPicker === "function",
    xmlName: S.order ? xmlFileName(S.order.supplier, S.order.orderDate) : "",
  };
}

function render() {
  const active = document.activeElement;
  const keep = active && app.contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  if (store.auth.required && !user) { app.innerHTML = loginHtml(S.error); return; }
  app.innerHTML = S.phase === "order" && S.order ? orderView(viewModel()) : startView(viewModel());
  if (keep) {
    const el = $(keep.id);
    if (el) { el.focus(); try { el.setSelectionRange(keep.start, keep.end); } catch { /* ei tekstikenttä */ } }
  }
}

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 30);
}
function setState(u) { Object.assign(S, u); scheduleRender(); }

/* ───────── Tilausten haku ja avaus ───────── */
const isLineDone = (rec) => rec && rec.qty !== undefined && rec.qty !== null && (rec.qty === 0 || rec.end !== undefined);

async function loadRecent() {
  try {
    const all = (await store.get("vastaanotto")) || {};
    recent = Object.entries(all).map(([id, o]) => ({
      id, supplier: o.meta?.supplier?.name || id, date: o.meta?.orderDate ? formatYmd(o.meta.orderDate) : "",
      total: Object.keys(o.lines || {}).length, done: Object.values(o.rec || {}).filter(isLineDone).length, xmlAt: o.xmlAt || null,
      sort: o.meta?.orderDate || "", loadedAt: o.meta?.loadedAt || 0,
    })).sort((a, b) => b.loadedAt - a.loadedAt).slice(0, 12);
  } catch { recent = []; }
}

function openOrder(id) {
  unsub?.();
  unsub = store.subscribe(`vastaanotto/${id}`, (val) => {
    if (!val?.meta) return;
    const lines = Object.entries(val.lines || {}).map(([k, l]) => ({ ...l })).sort((a, b) => (a.n || 0) - (b.n || 0));
    const recs = {};
    for (const [k, r] of Object.entries(val.rec || {})) recs[k] = { qty: r.qty ?? null, end: r.end === undefined ? null : r.end };
    S.order = { id, supplier: val.meta.supplier, orderDate: val.meta.orderDate, fileName: val.meta.fileName || "", lines };
    S.recs = recs;
    S.shelvingSentAt = val.shelving?.t || null;
    S.xmlAt = val.xmlAt || null;
    if (S.phase !== "order") S.phase = "order";
    scheduleRender();
  });
}

async function loadFile() {
  const f = $("order-file")?.files[0];
  if (!f) { setState({ error: "Valitse tilaustiedosto (.xlsx)" }); return; }
  setState({ loading: "Luetaan tilausta...", error: null, result: null });
  try {
    const order = await parseOrderWorkbook(await readXlsx(f), f.name);
    const existing = await store.get(`vastaanotto/${order.id}/meta`);
    if (existing && !confirm(`Tilaus ${order.supplier.name} ${formatYmd(order.orderDate)} on jo avattu. Jatketaanko olemassa olevaa vastaanottoa? (Peruuta = älä avaa)`)) { setState({ loading: null }); return; }
    if (!existing) {
      const lines = {};
      order.lines.forEach((l, i) => { lines[l.key] = { ...l, n: i }; });
      await store.set(`vastaanotto/${order.id}`, {
        meta: { supplier: order.supplier, orderDate: order.orderDate, fileName: order.fileName, loadedAt: Date.now(), by: currentWorker },
        lines,
      });
    }
    setState({ loading: null, tab: "lines", filter: "open", selectedKey: null });
    openOrder(order.id);
  } catch (e) { setState({ loading: null, error: "Tilauksen luku epäonnistui: " + e.message }); }
}

/* ───────── Rivin tallennus ───────── */
function setRec(key, patch) {
  const prev = S.recs[key] || { qty: null, end: null };
  const next = { ...prev, ...patch };
  if (next.qty === 0) next.end = "";
  S.recs[key] = next;
  const rec = { t: Date.now(), by: currentWorker };
  if (next.qty !== null) rec.qty = next.qty;
  if (next.end !== null && next.end !== undefined) rec.end = next.end;
  store.set(`vastaanotto/${S.order.id}/rec/${key}`, rec);
  scheduleRender();
}

function lineByKey(key) { return S.order.lines.find((l) => l.key === key); }

function advanceIfDone(key) {
  const l = lineByKey(key);
  const st = lineStatus(l, S.recs[key]);
  if (st === "pending" || st === "needsDate") return false;
  const lines = S.order.lines;
  const i = lines.findIndex((x) => x.key === key);
  for (let d = 1; d <= lines.length; d++) {
    const n = lines[(i + d) % lines.length];
    const s = lineStatus(n, S.recs[n.key]);
    if (s === "pending" || s === "needsDate") { selectLine(n.key); return true; }
  }
  S.selectedKey = null;
  return true;
}

function selectLine(key) {
  stopVoice();
  setState({ selectedKey: key, voiceCandidate: null });
  setTimeout(() => $("line-" + lineByKey(key)?.sku)?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
}

/* ───────── Puhe: määrä → vahvistus → päiväys → vahvistus ───────── */
function stopVoice() { voice?.handle?.stop(); voice = null; S.voiceText = null; S.voiceCandidate = null; }

function startVoice(key) {
  if (!speechSupported()) { setState({ error: "Puheentunnistus ei ole tuettu tässä selaimessa" }); return; }
  stopVoice();
  const rec = S.recs[key];
  const needQty = !(rec && rec.qty !== null && rec.qty !== undefined);
  voice = { key, mode: needQty ? "qty" : "date", pending: null, handle: null };
  voice.handle = listenText({
    onText: onVoiceText,
    onError: (e) => { voice = null; setState({ voiceText: null, error: e === "not-allowed" ? "Mikrofoni estetty" : e === "mic-loop" ? "Mikrofoni ei toimi — syötä käsin" : "Puhevirhe: " + e }); },
  });
  setState({ voiceText: needQty ? "🎤 Sano saapunut määrä" : "🎤 Sano päiväys", error: null });
}

function onVoiceText(raw) {
  if (!voice) return;
  const t = raw.trim().toLowerCase();
  const { key } = voice;
  const line = lineByKey(key);
  const say = (voiceText, voiceCandidate = null) => setState({ voiceText, voiceCandidate });

  if (voice.mode === "qty" || voice.mode === "qtyConfirm") {
    if (voice.mode === "qtyConfirm") {
      if (YES.includes(t)) {
        const q = voice.pending;
        setRec(key, { qty: q });
        if (q === 0) { stopVoice(); advanceIfDone(key); setState({ result: { type: "ok", text: "✓ Ei tullut" } }); return; }
        voice.mode = "date"; voice.pending = null;
        say("🎤 Sano päiväys (tai: ei päiväystä)", `✓ Määrä ${q}`);
        return;
      }
      if (NO.includes(t)) { voice.mode = "qty"; voice.pending = null; say("🎤 Sano määrä uudelleen"); return; }
    }
    if (/^(kaikki|kaikki tuli)$/.test(t)) { voice.pending = line.ordered; voice.mode = "qtyConfirm"; say(`🎤 ${line.ordered} (kaikki) — oikein vai väärin?`, `${line.ordered} kpl?`); return; }
    if (/^(ei tullut|ei saapunut)$/.test(t)) { voice.pending = 0; voice.mode = "qtyConfirm"; say("🎤 0 (ei tullut) — oikein vai väärin?", "0 kpl?"); return; }
    const n = parseSpokenNumber(t);
    if (n === null) { say(`🎤 "${t}" — sano määrä uudelleen`); return; }
    voice.pending = n; voice.mode = "qtyConfirm";
    say(`🎤 ${n} — oikein vai väärin?`, `${n} kpl?`);
    return;
  }

  // päiväys
  if (voice.mode === "dateConfirm") {
    if (YES.includes(t)) { const d = voice.pending; stopVoice(); setRec(key, { end: d.ymd }); advanceIfDone(key); setState({ result: { type: "ok", text: "✓ " + line.name } }); return; }
    if (NO.includes(t)) { voice.mode = "date"; voice.pending = null; say("🎤 Sano päiväys uudelleen"); return; }
  }
  if (/^(ei päiväystä|ei päivää|ei pvm|ei)$/.test(t)) { stopVoice(); setRec(key, { end: "" }); advanceIfDone(key); setState({ result: { type: "ok", text: "✓ Ei päiväystä" } }); return; }
  const d = parseSpokenDate(t);
  if (!d) { say(`🎤 "${t}" — en ymmärtänyt päiväystä, sano uudelleen`); return; }
  voice.pending = d; voice.mode = "dateConfirm";
  say(`🎤 ${d.label} — oikein vai väärin?`, d.label + "?");
}

/* ───────── Skannaus ───────── */
function handleScan(raw) {
  const code = raw.trim();
  if (!code || S.phase !== "order") return;
  const matches = S.order.lines.filter((l) => (l.ean && eanMatches(l.ean, code)) || l.sku === code);
  if (!matches.length) { setState({ error: "Koodi ei kuulu tähän tilaukseen", result: { type: "fail", text: "Ei löydy: " + code } }); return; }
  // Sama tuote voi olla usealla rivillä: valitse ensimmäinen kesken oleva, muuten ensimmäinen
  const isOpen = (l) => ["pending", "needsDate"].includes(lineStatus(l, S.recs[l.key]));
  const line = matches.find(isOpen) || matches[0];
  const key = line.key;
  if (S.tab !== "lines") S.tab = "lines";
  if (scanAdds) {
    const q = (S.recs[key]?.qty || 0) + 1;
    setRec(key, { qty: q });
    setState({ error: null, result: { type: "ok", text: `✓ ${line.name}: ${q}/${line.ordered}` }, selectedKey: key });
    setTimeout(() => $("line-" + line.sku)?.scrollIntoView({ block: "center" }), 60);
    return;
  }
  const st = lineStatus(line, S.recs[key]);
  const done = st !== "pending" && st !== "needsDate";
  setState({ error: null, result: { type: "ok", text: "→ " + line.name }, filter: done && S.filter === "open" ? "all" : S.filter });
  selectLine(key);
}

async function toggleCamera() {
  if (camera?.running) { camera.stop(); $("cam-wrap").style.display = "none"; scheduleRender(); return; }
  try { $("cam-wrap").style.display = "block"; await camera.start(); } catch { camera.stop(); $("cam-wrap").style.display = "none"; setState({ error: "Kamera ei käynnisty" }); }
  scheduleRender();
}

/* ───────── Kärryt ja vienti hyllytykseen ───────── */
async function loadMaster() {
  setState({ masterLoading: true, masterError: null });
  let gcsErr = "";
  try {
    const text = await fetchCsvText(GCS_CSV);
    if (text.includes("sku")) { setState({ master: parseMaster(text), masterLoading: false }); return; }
    gcsErr = "CSV ei sisällä oikeita sarakkeita";
  } catch (e) { gcsErr = e.message; }
  try {
    const csv = await store.get("files/csv");
    if (csv) { setState({ master: parseMaster(csv), masterLoading: false }); return; }
  } catch { /* ei varahakua */ }
  setState({ masterLoading: false, masterError: `Hyllypaikkoja ei saatu ladattua (${gcsErr})` });
}

async function toShelving() {
  if (!S.master) { await loadMaster(); if (!S.master) return; }
  const { items } = splitToCarts(S.order.lines, S.recs, S.master);
  if (!items.length) { setState({ error: "Ei saapuneita tuotteita vietäväksi" }); return; }
  if (!confirm(`Viedäänkö ${items.length} tuotetta hyllytykseen? Ne ilmestyvät Hyllytyksen kärryihin.`)) return;
  const sscc = `TT-${S.order.id}`;
  const box = {
    sscc, by: "vastaanotto", t: Date.now(),
    items: items.map((i) => ({ vnr: i.vnr, altVnr: "", name: i.name, ean: i.ean || "", qty: i.qty, location: i.location, cartId: i.cartId, physAisle: i.physAisle })),
  };
  await store.set(`sessions/${todayKey()}/scannedBoxes/${boxKey(sscc)}`, box);
  await store.set(`vastaanotto/${S.order.id}/shelving`, { t: Date.now() });
  setState({ error: null, result: { type: "ok", text: `✓ ${items.length} tuotetta viety hyllytykseen` } });
}

/* ───────── XML ja poikkeamat ───────── */
function xmlText() { return buildXml({ supplier: S.order.supplier, lines: S.order.lines, recs: S.recs }); }

async function markXml() { await store.set(`vastaanotto/${S.order.id}/xmlAt`, Date.now()); }

function downloadXml() {
  const name = xmlFileName(S.order.supplier, S.order.orderDate);
  const blob = new Blob([xmlText()], { type: "application/xml;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  markXml();
  setState({ result: { type: "ok", text: "✓ XML ladattu: " + name } });
}

async function saveToDir() {
  try {
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    const name = xmlFileName(S.order.supplier, S.order.orderDate);
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(new Blob([xmlText()], { type: "application/xml;charset=utf-8" }));
    await w.close();
    markXml();
    setState({ error: null, result: { type: "ok", text: `✓ Tallennettu kansioon: ${name}` } });
  } catch (e) {
    if (e.name === "AbortError") return;
    setState({ result: { type: "fail", text: "Kansioon tallennus ei onnistunut (" + e.name + ") — käytä latausta" } });
  }
}

function devsText() {
  const rows = deviationRows(S.order, S.recs);
  const head = `Poikkeamat: ${S.order.supplier.name}, tilaus ${formatYmd(S.order.orderDate)}`;
  if (!rows.length) return head + "\nEi poikkeamia.";
  return head + "\n" + rows.map(({ l, rec, st }) => `- ${l.name} (${l.sku}): tilattu ${l.ordered}, saapui ${rec.qty}${st === "none" ? " (ei tullut)" : ""}`).join("\n");
}

/* ───────── Tapahtumat ───────── */
const actions = {
  login: async () => { setState({ error: await doLogin(store, $("login-email"), $("login-pass")) }); },
  "load-file": loadFile,
  "open-order": (d) => { setState({ tab: "lines", filter: "open", selectedKey: null, error: null, result: null }); openOrder(d.id); },
  "to-start": async () => { unsub?.(); unsub = null; stopVoice(); await loadRecent(); setState({ phase: "start", order: null, recs: {}, error: null, result: null, master: S.master }); },
  tab: (d) => { setState({ tab: d.tab, error: null, result: null }); if (d.tab === "carts" && !S.master && !S.masterLoading) loadMaster(); },
  filter: (d) => setState({ filter: d.filter }),
  "select-line": (d) => (S.selectedKey === d.key ? setState({ selectedKey: null }) : selectLine(d.key)),
  "qty-delta": (d) => { const q = Math.max(0, (S.recs[d.key]?.qty || 0) + parseInt(d.delta, 10)); setRec(d.key, { qty: q }); },
  "all-came": (d) => { const l = lineByKey(d.key); setRec(d.key, { qty: l.ordered }); },
  "none-came": (d) => { setRec(d.key, { qty: 0 }); advanceIfDone(d.key); },
  "no-date": (d) => { setRec(d.key, { end: "" }); advanceIfDone(d.key); },
  "start-voice": (d) => startVoice(d.key),
  "stop-voice": () => { stopVoice(); scheduleRender(); },
  "toggle-cam": toggleCamera,
  "load-master": loadMaster,
  "to-shelving": toShelving,
  "dl-xml": () => {
    const open = S.order.lines.filter((l) => ["pending", "needsDate"].includes(lineStatus(l, S.recs[l.key]))).length;
    if (open && !confirm(`${open} riviä on kesken ja menee XML:ään määrällä 0. Ladataanko silti?`)) return;
    downloadXml();
  },
  "save-dir": saveToDir,
  "copy-devs": async () => { try { await navigator.clipboard.writeText(devsText()); setState({ result: { type: "ok", text: "✓ Kopioitu leikepöydälle" } }); } catch { setState({ result: { type: "fail", text: "Kopiointi ei onnistunut" } }); } },
  "dl-devs": () => {
    const rows = [["SKU", "Nimi", "Tilattu", "Saapui", "Tila"]];
    for (const { l, rec, st } of deviationRows(S.order, S.recs)) rows.push([l.sku, l.name, l.ordered, rec.qty, st]);
    downloadCsv(`poikkeamat_${S.order.orderDate}_${S.order.supplier.name}.csv`, rows, ";", { bom: true });
  },
};

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el.dataset, el);
});

app.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.change === "worker") { currentWorker = t.value; saveJson("wms_worker", currentWorker); return; }
  if (t.dataset.change === "scan-adds") { scanAdds = t.checked; saveJson("wms_vastaanotto_scanadds", scanAdds); return; }
  if (t.id === "qty-input") {
    const n = parseInt(t.value, 10);
    if (Number.isNaN(n) || n < 0 || n > 99999) { setState({ error: "Määrän pitää olla kokonaisluku ≥ 0" }); return; }
    setRec(t.dataset.key, { qty: n });
    return;
  }
  if (t.id === "end-date" && t.value) {
    const ymd = t.value.replace(/-/g, "");
    setRec(t.dataset.key, { end: ymd });
    advanceIfDone(t.dataset.key);
  }
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "scan-field") { e.preventDefault(); const v = e.target.value; e.target.value = ""; handleScan(v); return; }
  if (e.target.id === "end-text") {
    e.preventDefault();
    const d = parseSpokenDate(e.target.value);
    if (!d) { setState({ error: "Päiväys ei kelpaa (esim. 8/26 tai 16.12.2026)" }); return; }
    const key = e.target.dataset.key;
    e.target.value = "";
    setRec(key, { end: d.ymd });
    setState({ error: null, result: { type: "ok", text: "✓ " + d.label } });
    advanceIfDone(key);
    return;
  }
  if (e.target.id === "qty-input") { e.target.blur(); }
});

/* ───────── Käynnistys ───────── */
async function init() {
  store = await createStore();
  camera = createCamera({ video: $("cam-video"), flash: $("cam-flash"), onCode: handleScan });
  store.auth.onChange(async (u) => { user = u; if (u) await loadRecent(); render(); });
  render();
}

init();
