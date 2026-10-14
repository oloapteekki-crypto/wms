// Hyllytys: toimitusten purku ja hyllytys. Portattu hyllytysappiuusi/index.html:stä.
// Muutokset alkuperäiseen: yhteinen kirjasto + tallennuskerros (Firebase tai paikallinen), Firebase Auth (yhteinen laitetili),
// Suomen aikainen päivämäärä, XML:n merkistö luetaan prologista (ä/ö), atominen määrien kirjaus (increment),
// ei tuplattuja tehotietueita (deterministinen id), HTML-escape kaikelle datalle, ei inline-käsittelijöitä.
import { createStore, todayKey } from "../../lib/store/index.js";
import { createCamera, cameraSupported } from "../../lib/camera.js";
import { listenNumbers } from "../../lib/speech.js";
import { loadJson, saveJson, removeKeys } from "../../lib/storage.js";
import { fetchCsvText } from "../../lib/csv.js";
import { $ } from "../../lib/ui.js";
import { WORKERS } from "../../config/workers.js";
import {
  CARTS, parseLoc, physicalAisle, cartOfAisle, sortRoute, parseMaster, parseXml, mergeParsed, decodeXmlBuffer,
  enrichItem, eanMatches, boxKey, findBox, batchList, batchItems, totals,
} from "./domain.js";
import { loginView, setupView, scanView, cartSelectView, shelveView, reportView } from "./views.js";

const GCS_CSV = "https://storage.googleapis.com/olo-export-data/hyllytys-app-export000000000000.csv";
const KEY_STATE = "wms_hyllytys_state_v1";
const KEY_WORKER = "wms_worker";
const app = $("app");

const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const day = todayKey();
let store;
let fb = emptyFb();
let currentWorker = loadJson(KEY_WORKER, "");
let undoStack = [];
let tickTimer = null;
let user = null;

const initialState = () => ({
  phase: "setup", xmlBoxes: null, boxAltKeys: null, master: null, error: null, lastScanResult: null, loadProgress: null,
  selectedCart: null, selectedBatch: null, routeItems: [], shelved: {}, currentIdx: 0, confirmedLoc: null,
  activeBox: null, productLookup: null, shelveStartTime: null, pausedTime: 0, pauseStart: null,
});
let S = initialState();

function emptyFb() {
  return { scannedBoxes: {}, cartsTaken: {}, cartBatches: {}, shelved: {}, progress: {} };
}

const sessionPath = (p = "") => `sessions/${day}${p ? "/" + p : ""}`;

/* ───────── Tilan tallennus (sivun päivityksen yli) ───────── */
function persist() {
  if (S.phase === "setup") return;
  const keep = ["phase", "selectedCart", "selectedBatch", "routeItems", "shelved", "currentIdx", "confirmedLoc", "shelveStartTime", "pausedTime"];
  const o = Object.fromEntries(keep.map((k) => [k, S[k]]));
  if (S.phase === "scan" || S.phase === "cartSelect") { o.xmlBoxes = S.xmlBoxes; o.boxAltKeys = S.boxAltKeys; o.master = S.master; }
  try { sessionStorage.setItem(KEY_STATE, JSON.stringify({ day, ...o })); } catch { /* täynnä */ }
}

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY_STATE) || "null");
    if (!saved || saved.day !== day || !saved.phase || saved.phase === "setup") return false;
    if ((saved.phase === "scan" || saved.phase === "cartSelect") && (!saved.xmlBoxes || !saved.master)) return false;
    Object.assign(S, saved);
    delete S.day;
    return true;
  } catch { return false; }
}

const clearSaved = () => { try { sessionStorage.removeItem(KEY_STATE); } catch { /* ei väliä */ } };

/* ───────── Render ───────── */
function elapsedSec() {
  if (!S.shelveStartTime) return 0;
  const paused = S.pausedTime + (S.pauseStart ? Date.now() - S.pauseStart : 0);
  return Math.floor(Math.max(0, Date.now() - S.shelveStartTime - paused) / 1000);
}

function setState(u) {
  Object.assign(S, u);
  persist();
  render();
}

function viewModel() {
  return { S, fb, master: S.master, workers: WORKERS, currentWorker, sessionId, storeKind: store.kind, undoCount: undoStack.length, elapsedSec: elapsedSec(), now: Date.now() };
}

function render() {
  const v = viewModel();
  if (store.auth.required && !user) { hideScan(); app.innerHTML = loginView(v); return; }
  const back = `<a class="back" href="../../../index.html">← WMS</a>`;
  switch (S.phase) {
    case "setup": hideScan(); app.innerHTML = back + setupView(v); break;
    case "scan": app.innerHTML = scanView(v); setPlaceholder(scanPlaceholder()); showScan(); break;
    case "cartSelect": hideScan(); expireStaleLocks(); app.innerHTML = cartSelectView(v); break;
    case "shelve":
      if (!S.routeItems[S.currentIdx]) { finishShelving(true); return; }
      app.innerHTML = shelveView(v);
      setPlaceholder(isLocConfirmed() ? "Skannaa EAN" : "Skannaa paikka");
      showScan();
      break;
    case "report": hideScan(); app.innerHTML = reportView(v); break;
  }
  manageTick();
}

// Ajastin vain hyllytysnäkymässä. Päivittää pelkän kellotekstin (ei koko näkymää, jotta kosketukset eivät katoa).
function manageTick() {
  if (S.phase === "shelve" && !tickTimer) {
    tickTimer = setInterval(() => {
      const el = $("clock");
      if (el) el.textContent = clockText();
    }, 1000);
  } else if (S.phase !== "shelve" && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

export function clockText() {
  const s = elapsedSec();
  return `${Math.floor(s / 60)}:${(s % 60 < 10 ? "0" : "") + (s % 60)}${S.pauseStart ? " — ⏸ TAUKO" : ""}`;
}

function isLocConfirmed() {
  const cur = S.routeItems[S.currentIdx];
  return !!(S.confirmedLoc && cur?.location && cur.location.trim().toUpperCase() === S.confirmedLoc);
}

function scanPlaceholder() {
  if (!S.activeBox) return "Skannaa laatikko";
  const scanned = Object.values(S.activeBox.scannedEans || {}).reduce((s, n) => s + n, 0);
  return `Lue tuote (${scanned}/${S.activeBox.items.reduce((s, i) => s + i.qty, 0)})`;
}

/* ───────── Skannauskenttä ja kamera ───────── */
let camera;
let scanFocused = false;
const setPlaceholder = (t) => { $("scan-field").placeholder = t; };

function showScan() {
  $("scan-wrap").style.display = "block";
  if (!scanFocused) {
    const inp = $("scan-field");
    inp.focus();
    setTimeout(() => inp.blur(), 100); // MT90 "Fill in EditText" muistaa kentän – piilottaa ruutunäppäimistön
    scanFocused = true;
  }
}

function hideScan() {
  $("scan-wrap").style.display = "none";
  scanFocused = false;
  stopCamera();
  stopListening();
}

function stopCamera() {
  camera?.stop();
  $("cam-overlay").style.display = "none";
  $("cam-toggle").classList.remove("on");
}

async function toggleCamera() {
  if (camera?.running) { stopCamera(); return; }
  try {
    $("cam-overlay").style.display = "block";
    $("cam-toggle").classList.add("on");
    await camera.start();
  } catch (e) {
    stopCamera();
    alert("Kamera-virhe: " + e.message);
  }
}

/* ───────── Puheentunnistus ───────── */
let speech = null;
function stopListening() { speech?.stop(); speech = null; }

function startListening(vnr, qty) {
  stopListening();
  speech = listenNumbers({
    onStart: () => setState({ lastScanResult: { type: "ok", text: "🎤 Kuuntelen... sano loppumäärä" } }),
    onNumber: (num) => {
      const prev = S.shelved[vnr] || 0;
      const item = S.routeItems[S.currentIdx];
      undoStack.push({ vnr, prev, idx: S.currentIdx, name: item?.name || vnr });
      S.shelved[vnr] = Math.min(prev + num, qty);
      logShelveEvent(vnr, item, num, S.shelved[vnr], qty, "voice");
      syncProgress();
      if (S.shelved[vnr] >= qty) {
        stopListening();
        setState({ shelved: S.shelved, lastScanResult: { type: "ok", text: `🎤 +${num} → ${S.shelved[vnr]}/${qty} ✓ Valmis!` } });
        setTimeout(autoAdvance, 800);
      } else setState({ shelved: S.shelved, lastScanResult: { type: "ok", text: `🎤 +${num} → ${S.shelved[vnr]}/${qty}` } });
    },
    onUnrecognized: (text) => setState({ lastScanResult: { type: "fail", text: `🎤 "${text}" — ei tunnistettu numeroa` } }),
    onError: (e) => { speech = null; setState({ lastScanResult: { type: "fail", text: "🎤 Virhe: " + e } }); },
  });
}

/* ───────── Tallennuskerros ───────── */
function subscribeSession() {
  store.subscribe(sessionPath(), (val) => {
    const v = val || {};
    fb = {
      scannedBoxes: v.scannedBoxes || {}, cartsTaken: v.cartsTaken || {}, cartBatches: v.cartBatches || {},
      shelved: v.shelved || {}, progress: v.progress || {},
    };
    // Päivitetään vain laskuri, ettei koko näkymää piirretä uudelleen (estää näppäimistön avautumisen).
    if (S.phase === "cartSelect") render();
    else if (S.phase === "scan" && S.xmlBoxes) {
      const el = $("live-counters");
      if (el) {
        const scanned = Object.keys(fb.scannedBoxes);
        el.textContent = `${scanned.length}/${Object.keys(S.xmlBoxes).length + scanned.filter((k) => !(k in S.xmlBoxes)).length} laatikkoa luettu`;
      }
    }
  });
}

function expireStaleLocks() {
  for (const [key, t] of Object.entries(fb.cartsTaken)) {
    if (Date.now() - t.t > 30 * 60 * 1000) store.remove(sessionPath(`cartsTaken/${key}`));
  }
}

function syncProgress() {
  if (S.phase !== "shelve" || !S.selectedCart || !S.selectedBatch) return;
  store.set(sessionPath(`progress/${S.selectedCart}_${S.selectedBatch.id}_progress`), {
    shelved: S.shelved, idx: S.currentIdx, confirmedLoc: S.confirmedLoc, t: Date.now(),
  });
}

function logShelveEvent(vnr, item, added, total, expected, method) {
  if (!S.selectedCart || !S.selectedBatch) return;
  const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  store.set(`scanLog/${day}/${key}`, {
    t: Date.now(), worker: currentWorker, cart: S.selectedCart, batch: S.selectedBatch.id, batchNum: S.selectedBatch.num,
    vnr, name: item?.name || vnr, location: item?.location || "", added, total, expected, method,
  });
}

function performanceRecord(partial) {
  const { shelved, expected } = totals(S.routeItems, S.shelved);
  const cart = CARTS.find((c) => c.id === S.selectedCart);
  const rec = {
    worker: currentWorker || "(ei valittu)", cart: S.selectedCart, cartName: `${cart?.name || ""} #${S.selectedBatch?.num || ""}`,
    batch: S.selectedBatch?.id || "", start: S.shelveStartTime, end: Date.now(), elapsed: elapsedSec() * 1000,
    shelved, expected, items: S.routeItems.length,
  };
  if (partial) rec.partial = true;
  return rec;
}

// Deterministinen id: osittainen tietue korvautuu valmiilla, eikä sivun päivitys tuplaa tehoraporttia.
const perfPath = () => sessionPath(`performance/${S.selectedCart}_${S.selectedBatch?.id}_${sessionId}`);

/* ───────── Toiminnot: lataus ───────── */
async function loadMaster() {
  let gcsErr = "", fbErr = "";
  try {
    const text = await fetchCsvText(GCS_CSV);
    if (text.includes("sku")) return parseMaster(text);
    gcsErr = "CSV ei sisällä oikeita sarakkeita";
  } catch (e) { gcsErr = e.message; }
  try {
    const csv = await store.get("files/csv");
    if (csv) return parseMaster(csv);
    fbErr = "ei dataa";
  } catch (e) { fbErr = e.message; }
  throw new Error(`Tuoterekisteriä ei saatu ladattua. GCS: ${gcsErr}, tietokanta: ${fbErr}`);
}

async function loadData() {
  setState({ error: null, loadProgress: "Haetaan tuoterekisteriä..." });
  try {
    const master = await loadMaster();
    setState({ loadProgress: "Haetaan XML-tiedostoja..." });
    const xml = await store.get("files/xml");
    if (!xml) throw new Error("XML-tiedostoja ei löydy — lataa ne ensin tietokoneella");
    const parsed = Object.values(xml).map(parseXml);
    const { boxes, altKeys } = mergeParsed(parsed);
    subscribeSession();
    setState({ xmlBoxes: boxes, boxAltKeys: altKeys, master, phase: "scan", loadProgress: null });
  } catch (e) { setState({ error: e.message, loadProgress: null }); }
}

async function uploadFiles() {
  const csv = $("csv-upload").files;
  const xml = $("xml-upload").files;
  if (!csv.length && !xml.length) { setState({ error: "Valitse vähintään yksi tiedosto" }); return; }
  setState({ error: null, loadProgress: "Ladataan..." });
  try {
    if (csv.length) {
      setState({ loadProgress: "Ladataan tuoterekisteriä..." });
      await store.update("files", { csv: await csv[0].text(), csvUpdated: Date.now(), csvName: csv[0].name });
    }
    if (xml.length) {
      await store.remove("files/xml");
      for (let i = 0; i < xml.length; i++) {
        setState({ loadProgress: `XML ${i + 1}/${xml.length}...` });
        const name = xml[i].name.replace(/[.#$/[\]]/g, "_");
        await store.set(`files/xml/${name}`, decodeXmlBuffer(await xml[i].arrayBuffer()));
      }
      await store.set("files/xmlUpdated", Date.now());
    }
    setState({ loadProgress: null, error: null, lastScanResult: { type: "ok", text: "✓ Tiedostot ladattu!" } });
  } catch (e) { setState({ error: "Latausvirhe: " + e.message, loadProgress: null }); }
}

/* ───────── Toiminnot: purku ───────── */
function addBox(code) {
  if (!code) return;
  setState({ error: null, lastScanResult: null });
  const sscc = findBox(code, S.xmlBoxes, S.boxAltKeys, (k) => !!fb.scannedBoxes[boxKey(k)]);
  if (!sscc) { setState({ error: "Koodi ei löydy", lastScanResult: { type: "fail", text: "Ei löydy" } }); return; }
  if (fb.scannedBoxes[boxKey(sscc)]) { setState({ error: "Jo skannattu", lastScanResult: { type: "fail", text: "Jo skannattu" } }); return; }
  const items = S.xmlBoxes[sscc].map((i) => {
    const e = enrichItem(i, S.master);
    return { vnr: e.vnr, altVnr: e.altVnr, name: e.name, ean: e.ean, qty: e.qty, location: e.location, cartId: e.cartId, physAisle: e.physAisle };
  });
  const data = { sscc, items, by: sessionId, t: Date.now() };
  fb.scannedBoxes[boxKey(sscc)] = data; // heti paikallisesti, jotta näkymä päivittyy
  store.set(sessionPath(`scannedBoxes/${boxKey(sscc)}`), data);
  setState({ activeBox: { sscc, items, scannedEans: {} }, lastScanResult: { type: "ok", text: `✓ Laatikko (${items.length} tuotetta)` }, productLookup: null });
}

function removeBox(sscc) {
  delete fb.scannedBoxes[boxKey(sscc)];
  store.remove(sessionPath(`scannedBoxes/${boxKey(sscc)}`));
}

function closeBatch(cartId) {
  const batchId = Date.now().toString(36);
  const data = { by: sessionId, t: Date.now() };
  (fb.cartBatches[cartId] ||= {})[batchId] = data;
  store.set(sessionPath(`cartBatches/${cartId}/${batchId}`), data);
}

function lookupEan(ean) {
  if (!ean || !S.master) return;
  let info = null;
  const ab = S.activeBox;
  const boxItem = ab?.items.find((i) => eanMatches(i.ean, ean));
  if (boxItem) {
    const pl = parseLoc((boxItem.location || "").trim());
    info = { name: boxItem.name, ean: boxItem.ean || ean, sku: boxItem.vnr, location: boxItem.location || "—", pl, pa: boxItem.physAisle || null, cartId: boxItem.cartId || null, qty: boxItem.qty };
  } else {
    let found = null, foundNoLoc = null;
    for (const [sku, m] of Object.entries(S.master)) {
      if (!eanMatches(m.ean, ean)) continue;
      if (parseLoc((m.location || "").trim())) { found = { sku, ...m }; break; }
      foundNoLoc ||= { sku, ...m };
    }
    found ||= foundNoLoc;
    if (!found) { setState({ lastScanResult: { type: "fail", text: `EAN ${ean} ei löydy` }, error: null }); return; }
    const pl = parseLoc((found.location || "").trim());
    const pa = pl ? physicalAisle(pl) : null;
    let qty = 0;
    for (const b of Object.values(fb.scannedBoxes)) for (const i of b.items || []) if (i.ean === found.ean || i.vnr === found.sku) qty += i.qty;
    info = { name: found.name, ean: found.ean, sku: found.sku, location: found.location || "—", pl, pa, cartId: pa ? cartOfAisle(pa) : null, qty };
  }
  const cart = info.cartId ? CARTS.find((c) => c.id === info.cartId) : null;
  let text = cart ? `${cart.icon} ${cart.name}` : "";
  if (info.pa && info.pa !== "RX" && info.pa !== "JK") text += ` — levy ${info.pa}`;
  if (info.pl?.type === "rx") text = "💊 Reseptilääke";
  if (info.pl?.type === "cold") text = "❄️ Jääkaappi";
  if (!info.pl) text = "📦 UUSI-hyllyyn";

  let nextBox = ab;
  if (ab) {
    ab.scannedEans ||= {};
    ab.scannedEans[ean] = (ab.scannedEans[ean] || 0) + 1;
    const total = ab.items.reduce((s, i) => s + i.qty, 0);
    if (Object.values(ab.scannedEans).reduce((s, n) => s + n, 0) >= total) nextBox = null;
  }
  setState({
    lastScanResult: { type: "ok", text }, error: null, activeBox: nextBox,
    productLookup: { name: info.name, ean: info.ean, sku: info.sku, location: info.location, cart, pa: info.pa, qty: info.qty },
  });
}

/* ───────── Toiminnot: hyllytys ───────── */
function selectCart(cartId, batchId) {
  if (!currentWorker) { setState({ error: "Valitse ensin käyttäjä aloitusnäkymästä" }); return; }
  const list = batchList(fb.cartBatches, cartId);
  const batch = list.find((b) => b.id === batchId) || list[list.length - 1];
  const prev = fb.shelved[`${cartId}_${batch.id}`] || {};
  const remaining = batchItems(fb.scannedBoxes, batch, cartId, S.master)
    .map((i) => ({ ...i, qty: i.qty - (prev[i.vnr] || 0) }))
    .filter((i) => i.qty > 0);

  const progress = fb.progress[`${cartId}_${batch.id}_progress`];
  const shelved = progress?.shelved || {};
  store.set(sessionPath(`cartsTaken/${cartId}_${batch.id}`), { by: sessionId, t: Date.now() });
  undoStack = [];
  setState({
    selectedCart: cartId, selectedBatch: batch, routeItems: sortRoute(remaining), shelved,
    currentIdx: progress?.idx || 0, confirmedLoc: progress?.confirmedLoc || null, phase: "shelve",
    lastScanResult: progress ? { type: "ok", text: "↩ Jatkettu edellisestä" } : null, error: null,
    shelveStartTime: Date.now(), pausedTime: 0, pauseStart: null,
  });
}

function confirmLocation(code) {
  if (!code || S.pauseStart) return;
  setState({ error: null, lastScanResult: null });
  const cur = S.routeItems[S.currentIdx];
  if (!cur) return;
  const sc = code.trim().toUpperCase();
  if (sc === cur.location.trim().toUpperCase()) { setState({ confirmedLoc: sc, lastScanResult: { type: "ok", text: "✓ " + cur.location } }); syncProgress(); return; }
  const other = S.routeItems.findIndex((i) => i.location && i.location.trim().toUpperCase() === sc);
  if (other !== -1) { setState({ confirmedLoc: sc, currentIdx: other, lastScanResult: { type: "ok", text: "✓ " + S.routeItems[other].location } }); syncProgress(); return; }
  setState({ error: "Paikka ei reitillä", lastScanResult: { type: "fail", text: "Väärä" } });
}

function addOne(item, idx) {
  const p = S.shelved[item.vnr] || 0;
  undoStack.push({ vnr: item.vnr, prev: p, idx, name: item.name });
  S.shelved[item.vnr] = p + 1;
  logShelveEvent(item.vnr, item, 1, p + 1, item.qty, "scan");
  const complete = p + 1 >= item.qty;
  const label = idx === S.currentIdx ? "" : item.name + " ";
  setState({
    shelved: S.shelved, currentIdx: idx,
    lastScanResult: { type: "ok", text: `✓ ${label}${p + 1}/${item.qty}${complete ? " Valmis!" : " — 🎤 sano loppumäärä"}` },
  });
  syncProgress();
  if (complete) setTimeout(autoAdvance, 800);
  else startListening(item.vnr, item.qty);
}

function confirmEan(code) {
  if (!code || S.pauseStart) return;
  stopListening();
  setState({ error: null, lastScanResult: null });
  if (!S.confirmedLoc) { setState({ error: "Skannaa paikka ensin" }); return; }
  const cur = S.routeItems[S.currentIdx];
  if (cur && eanMatches(cur.ean, code)) { addOne(cur, S.currentIdx); return; }
  const si = S.routeItems.findIndex((i) => i.location && i.location.trim().toUpperCase() === S.confirmedLoc && eanMatches(i.ean, code));
  if (si === -1) { setState({ error: "EAN ei tunnistettu" }); return; }
  if ((S.shelved[S.routeItems[si].vnr] || 0) >= S.routeItems[si].qty) { setState({ error: "Jo valmis" }); return; }
  addOne(S.routeItems[si], si);
}

function setQty(vnr, n) {
  const prev = S.shelved[vnr] || 0;
  if (n === prev) return;
  const item = S.routeItems.find((i) => i.vnr === vnr);
  undoStack.push({ vnr, prev, idx: S.currentIdx, name: item?.name || vnr });
  logShelveEvent(vnr, item, n - prev, n, item?.qty || 0, "manual");
  S.shelved[vnr] = n;
  setState({ shelved: S.shelved });
  syncProgress();
}

function undo() {
  const a = undoStack.pop();
  if (!a) return;
  S.shelved[a.vnr] = a.prev;
  setState({ shelved: S.shelved, currentIdx: a.idx, lastScanResult: { type: "ok", text: "↩ Peruttu: " + a.name } });
  syncProgress();
}

function autoAdvance() {
  for (let i = S.currentIdx + 1; i < S.routeItems.length; i++) {
    if ((S.shelved[S.routeItems[i].vnr] || 0) < S.routeItems[i].qty) { navTo(i); return; }
  }
  finishShelving(true);
}

function navTo(idx) {
  if (idx < 0 || idx >= S.routeItems.length) return;
  stopListening();
  const same = (S.routeItems[S.currentIdx]?.location || "").trim().toUpperCase() === (S.routeItems[idx]?.location || "").trim().toUpperCase();
  setState({ currentIdx: idx, confirmedLoc: same ? S.confirmedLoc : null, lastScanResult: null, error: null });
  syncProgress();
}

function togglePause() {
  if (S.pauseStart) {
    S.pausedTime += Date.now() - S.pauseStart;
    setState({ pauseStart: null, lastScanResult: { type: "ok", text: "▶ Jatketaan" } });
  } else {
    stopListening();
    setState({ pauseStart: Date.now(), lastScanResult: { type: "ok", text: "⏸ Tauko — skannaus estetty" } });
  }
}

function finishShelving(skipConfirm) {
  stopListening();
  if (!skipConfirm) {
    const { shelved, expected } = totals(S.routeItems, S.shelved);
    if (!confirm(shelved < expected ? `Kesken (${shelved}/${expected}). Lopeta?` : "Lopeta?")) return;
  }
  if (S.selectedCart && S.selectedBatch) {
    const key = `${S.selectedCart}_${S.selectedBatch.id}`;
    // Atominen lisäys: toinen laite ei ylikirjoita määriä.
    for (const [vnr, n] of Object.entries(S.shelved)) if (n > 0) store.increment(sessionPath(`shelved/${key}/${vnr}`), n);
    store.remove(sessionPath(`cartsTaken/${key}`));
    store.remove(sessionPath(`progress/${key}_progress`));
    if (S.shelveStartTime) store.set(perfPath(), performanceRecord(false));
  }
  setState({ phase: "report" });
}

function resetDay() {
  if (!confirm("Nollaa KAIKKI päivän data? Skannatut laatikot, kärryt, hyllytykset — kaikki katoaa.")) return;
  fb = emptyFb();
  store.remove(sessionPath());
  clearSaved();
  undoStack = [];
  setState({ phase: "scan", activeBox: null, lastScanResult: null, error: null, productLookup: null });
}

// Sivun päivityksen jälkeen palautettu hyllytysvaihe ei sisällä XML/tuoterekisteri-dataa: ladataan uudelleen.
function leaveTo(phase) {
  clearSaved(); undoStack = [];
  const reset = { selectedCart: null, selectedBatch: null, routeItems: [], shelved: {}, currentIdx: 0, confirmedLoc: null };
  if (!S.xmlBoxes || !S.master) setState({ ...reset, phase: "setup", lastScanResult: { type: "ok", text: "Lataa tiedot uudelleen jatkaaksesi" } });
  else setState({ ...reset, phase });
}
const leaveToCartSelect = () => leaveTo("cartSelect");
const leaveToScan = () => leaveTo("scan");

/* ───────── Skannauksen reititys ───────── */
function processScan(val) {
  const code = (val || "").trim();
  if (!code) return;
  if (S.phase === "scan") {
    const known = findBox(code, S.xmlBoxes, S.boxAltKeys, () => true);
    if (known || code.length >= 15) addBox(code);
    else lookupEan(code);
  } else if (S.phase === "shelve") {
    if (!isLocConfirmed()) confirmLocation(code);
    else confirmEan(code);
  }
}

/* ───────── Tapahtumat ───────── */
const actions = {
  login: async () => {
    try { await store.auth.signIn($("login-email").value.trim(), $("login-pass").value); setState({ error: null }); }
    catch (e) { setState({ error: "Kirjautuminen epäonnistui: " + (e.code || e.message) }); }
  },
  load: loadData,
  upload: uploadFiles,
  "close-lookup": () => setState({ productLookup: null }),
  "add-box": (d) => addBox(d.code),
  "close-box": () => setState({ activeBox: null }),
  "remove-box": (d) => { if (confirm("Poista laatikko?")) { removeBox(d.sscc); setState({ activeBox: null, lastScanResult: { type: "ok", text: "Laatikko poistettu" } }); } },
  "show-box": (d) => { const b = fb.scannedBoxes[d.key]; if (b?.items) setState({ activeBox: { sscc: b.sscc || d.key, items: b.items } }); },
  "close-batch": (d) => { if (confirm(`${CARTS.find((c) => c.id === d.cart).name} #${d.num} valmis hyllytykseen?`)) { closeBatch(d.cart); setState({ phase: "cartSelect" }); } },
  "to-cart-select": () => setState({ phase: "cartSelect", error: null }),
  "to-scan": () => setState({ phase: "scan", error: null }),
  "reset-day": resetDay,
  "release-cart": (d) => { if (confirm("Vapauta kärry? Toisen laitteen hyllytys keskeytyy.")) { store.remove(sessionPath(`cartsTaken/${d.cart}_${d.batch}`)); } },
  "select-cart": (d) => selectCart(d.cart, d.batch),
  adjust: (d) => setQty(d.vnr, Math.max(0, (S.shelved[d.vnr] || 0) + parseInt(d.delta, 10))),
  nav: (d) => navTo(S.currentIdx + parseInt(d.delta, 10)),
  undo,
  pause: togglePause,
  finish: () => finishShelving(false),
  "another-cart": leaveToCartSelect,
  "continue-unload": leaveToScan,
};

const changes = {
  worker: (el) => { currentWorker = el.value; saveJson(KEY_WORKER, currentWorker); },
  "qty-manual": (el) => { const n = parseInt(el.value, 10); if (!Number.isNaN(n) && n >= 0) setQty(el.dataset.vnr, n); },
};

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el.dataset, el);
});
app.addEventListener("change", (e) => {
  const el = e.target.closest("[data-change]");
  if (el && changes[el.dataset.change]) changes[el.dataset.change](el);
});

$("scan-field").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const v = e.target.value;
  e.target.value = "";
  processScan(v);
});
$("cam-toggle").addEventListener("click", toggleCamera);
$("cam-close").addEventListener("click", stopCamera);

// Sivu piilotetaan/suljetaan kesken hyllytyksen: tallennetaan osittainen tehotietue (korvautuu valmiilla).
window.addEventListener("pagehide", () => {
  if (S.phase === "shelve" && S.shelveStartTime) { persist(); store.set(perfPath(), performanceRecord(true)); }
});
window.addEventListener("beforeunload", (e) => {
  if (S.phase === "shelve") { e.preventDefault(); e.returnValue = "Hyllytyserä on kesken."; }
});

/* ───────── Käynnistys ───────── */
async function init() {
  store = await createStore();
  camera = createCamera({ video: $("cam-video"), flash: $("cam-flash"), onCode: processScan });
  if (!cameraSupported()) $("cam-toggle").style.display = "none";

  store.auth.onChange((u) => { user = u; render(); });

  if (restore()) {
    subscribeSession();
    render();
    const nb = document.createElement("div");
    nb.className = "notice";
    nb.innerHTML = `✓ Edellinen erä palautettu <button class="btn-sm" id="nb-ok" style="margin-left:12px;background:#3b82f6;color:#fff;padding:4px 12px;font-size:12px">OK</button> <button class="btn-sm btn-outline" id="nb-reset" style="margin-left:4px;padding:4px 12px;font-size:12px">Alusta</button>`;
    document.body.prepend(nb);
    $("nb-ok").onclick = () => nb.remove();
    $("nb-reset").onclick = () => { clearSaved(); location.reload(); };
  } else render();
}

init();
