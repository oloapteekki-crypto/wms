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
import { parseOrderWorkbook, buildRec, lineKey, lineStatus, buildXml, xmlFileName, splitToCarts, placement } from "./domain.js";
import { startView, orderView, deviationRows } from "./views.js";

const GCS_CSV = "https://storage.googleapis.com/olo-export-data/hyllytys-app-export000000000000.csv";
const YES = ["oikein", "kyllä", "joo", "jep", "ok", "okei"];
const NO = ["väärin", "ei", "uudelleen", "uusiksi"];
const app = $("app");

let store, user = null, camera = null;
let currentWorker = loadJson("wms_worker", "");
let recent = [];
let unsub = null;
let voice = null; // {key, mode, pending, handle}
let renderTimer = null;

let S = {
  phase: "start", order: null, recs: {}, tab: "lines", filter: "open", selectedKey: null, error: null, result: null, loading: null,
  master: null, masterError: null, masterLoading: false, voiceCandidate: null, voiceText: null, draft: { key: null, qty: null, end: null }, shelvingSentAt: null, xmlAt: null,
};

/* ───────── Render (säilyttää kentän fokuksen) ───────── */
function viewModel() {
  return {
    S, workers: WORKERS, currentWorker, storeKind: store.kind, recent, voiceOn: !!voice,
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
const isLineDone = (rec) => { const b = Object.values(rec?.b || {}); return !!rec?.none || (b.length > 0 && b.every((x) => x.end !== undefined)); };

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
    for (const [k, r] of Object.entries(val.rec || {})) { const rec = buildRec(r); if (rec) recs[k] = rec; }
    S.order = { id, supplier: val.meta.supplier, orderDate: val.meta.orderDate, fileName: val.meta.fileName || "", updatedAt: val.meta.updatedAt || null, lines };
    S.recs = recs;
    S.shelvingSentAt = val.shelving?.t || null;
    S.xmlAt = val.xmlAt || null;
    if (S.phase !== "order") S.phase = "order";
    scheduleRender();
    // Hyllypaikat tarvitaan heti, jotta sovellus voi kertoa skannattaessa mihin kärryyn tuote laitetaan
    if (!S.master && !S.masterLoading && !S.masterError) loadMaster();
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

/* ───────── Rivin tallennus: laatikkoerät ───────── */
// Jokainen laatikko on oma erä (määrä + päiväys); rivin saapunut määrä on erien summa.
const recPath = (key) => `vastaanotto/${S.order.id}/rec/${key}`;
function localRec(key, mutate) {
  const raw = { none: S.recs[key]?.none || false, b: {} };
  for (const b of S.recs[key]?.batches || []) raw.b[b.id] = { qty: b.qty, ...(b.end !== null ? { end: b.end } : {}), t: b.t, by: b.by };
  mutate(raw);
  const rec = buildRec(raw);
  if (rec) S.recs[key] = rec; else delete S.recs[key];
  scheduleRender();
}

function addBatch(key, qty, end) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const b = { qty, t: Date.now(), by: currentWorker };
  if (end !== null && end !== undefined) b.end = end;
  localRec(key, (raw) => { raw.none = false; raw.b[id] = b; });
  store.remove(`${recPath(key)}/none`);
  store.set(`${recPath(key)}/b/${id}`, b);
}

function setBatchEnd(key, id, end) {
  localRec(key, (raw) => { if (raw.b[id]) raw.b[id].end = end; });
  store.set(`${recPath(key)}/b/${id}/end`, end);
}

function removeBatch(key, id) {
  localRec(key, (raw) => { delete raw.b[id]; });
  store.remove(`${recPath(key)}/b/${id}`);
}

function markNone(key) {
  localRec(key, (raw) => { raw.b = {}; raw.none = true; });
  store.set(recPath(key), { none: true, t: Date.now(), by: currentWorker });
}

function clearLine(key) {
  localRec(key, (raw) => { raw.b = {}; raw.none = false; });
  store.remove(recPath(key));
}

const resetDraft = (key) => { S.draft = { key, qty: null, end: S.recs[key]?.batches?.at(-1)?.end ?? null }; };
function lineByKey(key) { return S.order.lines.find((l) => l.key === key); }

// Laatikko kirjattu: sulje rivi ja muistuta kärrystä. Seuraavaan riviin EI siirrytä itsestään:
// tuotteet puretaan laatikoista ja skannataan missä järjestyksessä tahansa; sama tuote voi tulla uudestaan toisesta laatikosta.
function finishLine(key, what = "") {
  const l = lineByKey(key);
  const rec = S.recs[key];
  const st = lineStatus(l, rec);
  if (st === "pending" || st === "needsDate") return false;
  const p = rec.qty > 0 ? placement(l, S.master) : null;
  stopVoice();
  const sum = st === "none" ? " — ei tullut" : ` (yhteensä ${rec.qty}/${l.ordered})`;
  setState({
    selectedKey: null, voiceCandidate: null, error: null,
    result: { type: "ok", text: `✓ ${l.name}${what ? " " + what : ""}${sum}${p ? " → " + p.label + (p.aisle ? " (levy " + p.aisle + ")" : "") : ""}` },
  });
  return true;
}

// Kirjaa luonnoksen (määrä + päiväys) uudeksi laatikkoeräksi
function commitDraft(key) {
  const d = S.draft;
  if (d.key !== key || !(d.qty > 0)) { setState({ error: "Syötä tämän laatikon määrä (> 0)" }); return false; }
  if (d.end === null) { setState({ error: "Syötä päiväys tai valitse Ei päiväystä" }); return false; }
  addBatch(key, d.qty, d.end);
  resetDraft(key);
  return finishLine(key, `+${d.qty}`);
}

function selectLine(key) {
  stopVoice();
  resetDraft(key);
  setState({ selectedKey: key, voiceCandidate: null });
  setTimeout(() => $("line-" + lineByKey(key)?.sku)?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
}
/* ───────── Puhe: määrä → vahvistus → päiväys → vahvistus ───────── */
function stopVoice() { voice?.handle?.stop(); voice = null; S.voiceText = null; S.voiceCandidate = null; }

function startVoice(key) {
  if (!speechSupported()) { setState({ error: "Puheentunnistus ei ole tuettu tässä selaimessa" }); return; }
  stopVoice();
  voice = { key, mode: "qty", pending: null, qty: null, handle: null };
  voice.handle = listenText({
    onText: onVoiceText,
    onError: (e) => { voice = null; setState({ voiceText: null, error: e === "not-allowed" ? "Mikrofoni estetty" : e === "mic-loop" ? "Mikrofoni ei toimi — syötä käsin" : "Puhevirhe: " + e }); },
  });
  setState({ voiceText: "🎤 Sano tämän laatikon määrä", error: null });
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
        if (q === 0) { markNone(key); finishLine(key); return; }
        voice.qty = q; voice.mode = "date"; voice.pending = null;
        say("🎤 Sano päiväys (tai: ei päiväystä)", `✓ Laatikossa ${q} kpl`);
        return;
      }
      if (NO.includes(t)) { voice.mode = "qty"; voice.pending = null; say("🎤 Sano määrä uudelleen"); return; }
    }
    const left = Math.max(0, line.ordered - (S.recs[key]?.qty || 0));
    if (/^(loput|loput tuli|kaikki|kaikki tuli)$/.test(t)) { voice.pending = left; voice.mode = "qtyConfirm"; say(`🎤 ${left} (loput) — oikein vai väärin?`, `${left} kpl?`); return; }
    if (/^(ei tullut|ei saapunut)$/.test(t)) { voice.pending = 0; voice.mode = "qtyConfirm"; say("🎤 0 (ei tullut) — oikein vai väärin?", "0 kpl?"); return; }
    const n = parseSpokenNumber(t);
    if (n === null) { say(`🎤 "${t}" — sano määrä uudelleen`); return; }
    voice.pending = n; voice.mode = "qtyConfirm";
    say(`🎤 ${n} — oikein vai väärin?`, `${n} kpl?`);
    return;
  }

  // päiväys
  const commitVoice = (end) => { const q = voice.qty; addBatch(key, q, end); resetDraft(key); finishLine(key, `+${q}`); };
  if (voice.mode === "dateConfirm") {
    if (YES.includes(t)) { commitVoice(voice.pending.ymd); return; }
    if (NO.includes(t)) { voice.mode = "date"; voice.pending = null; say("🎤 Sano päiväys uudelleen"); return; }
  }
  if (/^(ei päiväystä|ei päivää|ei pvm|ei)$/.test(t)) { commitVoice(""); return; }
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
  "refresh-recent": async () => { await loadRecent(); setState({ error: null }); },
  "open-order": (d) => { setState({ tab: "lines", filter: "open", selectedKey: null, error: null, result: null }); openOrder(d.id); },
  "to-start": async () => { unsub?.(); unsub = null; stopVoice(); await loadRecent(); setState({ phase: "start", order: null, recs: {}, error: null, result: null, master: S.master }); },
  tab: (d) => { setState({ tab: d.tab, error: null, result: null }); if (d.tab === "carts" && !S.master && !S.masterLoading) loadMaster(); },
  filter: (d) => setState({ filter: d.filter }),
  "select-line": (d) => (S.selectedKey === d.key ? setState({ selectedKey: null }) : selectLine(d.key)),
  "qty-delta": (d) => { S.draft.qty = Math.max(0, (S.draft.qty || 0) + parseInt(d.delta, 10)); scheduleRender(); },
  "rest-came": (d) => { const l = lineByKey(d.key); S.draft.qty = Math.max(1, l.ordered - (S.recs[d.key]?.qty || 0)); scheduleRender(); },
  "none-came": (d) => { markNone(d.key); finishLine(d.key); },
  "no-date": (d) => { S.draft.end = ""; scheduleRender(); },
  "add-batch": (d) => commitDraft(d.key),
  "del-batch": (d) => { if (confirm("Poistetaanko tämä laatikko kirjauksista?")) removeBatch(d.key, d.id); },
  "clear-line": (d) => { clearLine(d.key); resetDraft(d.key); },
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
  if (t.id === "qty-input") {
    const n = parseInt(t.value, 10);
    if (Number.isNaN(n) || n < 0 || n > 99999) { setState({ error: "Määrän pitää olla kokonaisluku ≥ 0" }); return; }
    S.draft.qty = n;
    scheduleRender();
    return;
  }
  if (t.id === "end-date" && t.value) { S.draft.end = t.value.replace(/-/g, ""); scheduleRender(); return; }
  if (t.dataset.change === "batch-end" && t.value) setBatchEnd(t.dataset.key, t.dataset.id, t.value.replace(/-/g, ""));
});

// Määrä talteen kirjoitettaessa, jotta uudelleenpiirto (esim. päiväyksen valinta) ei hävitä syötettyä lukua
app.addEventListener("input", (e) => {
  if (e.target.id !== "qty-input") return;
  const n = parseInt(e.target.value, 10);
  S.draft.qty = Number.isNaN(n) ? null : n;
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "scan-field") { e.preventDefault(); const v = e.target.value; e.target.value = ""; handleScan(v); return; }
  if (e.target.id === "end-text") {
    e.preventDefault();
    const d = parseSpokenDate(e.target.value);
    if (!d) { setState({ error: "Päiväys ei kelpaa (esim. 8/26 tai 16.12.2026)" }); return; }
    e.target.value = "";
    S.draft.end = d.ymd;
    setState({ error: null });
    return;
  }
  if (e.target.id === "qty-input") {
    const n = parseInt(e.target.value, 10);
    if (!Number.isNaN(n)) S.draft.qty = n;
    if (S.draft.end !== null) commitDraft(e.target.dataset.key); else { e.target.blur(); scheduleRender(); }
  }
});

/* ───────── Käynnistys ───────── */
async function init() {
  store = await createStore();
  camera = createCamera({ video: $("cam-video"), flash: $("cam-flash"), onCode: handleScan });
  store.auth.onChange(async (u) => { user = u; if (u) await loadRecent(); render(); });
  render();
}

init();
