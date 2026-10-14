// Inventointi (laskenta). Portattu hyllytysappiuusi/inventointi.html:stä.
// Muutokset alkuperäiseen: yhteinen kirjasto + tallennuskerros (Firebase Auth), dataa haetaan VAIN käyttäjän käynnistämänä
// (ei taustahakuja), tuore data BigQuery-viennistä (CSV-lataus varakeinona), Suomen aikainen päivä, XSS-suojaus,
// määrä hyväksytään vain 0–9999 kokonaislukuna (pitkä numero = viivakoodi, ei määrä), ei inline-käsittelijöitä.
import { createStore, todayKey } from "../../lib/store/index.js";
import { createCamera, cameraSupported } from "../../lib/camera.js";
import { listenText, parseSpokenNumber, speechSupported } from "../../lib/speech.js";
import { loadJson, saveJson } from "../../lib/storage.js";
import { downloadCsv } from "../../lib/csv.js";
import { loginHtml, doLogin } from "../../lib/auth-ui.js";
import { $ } from "../../lib/ui.js";
import { WORKERS } from "../../config/workers.js";
import { sortByRoute, groupShelves, rowsAll, rowsDeviations, rowsToday } from "./domain.js";
import { fetchExport, loadFromFiles, saveSnapshot, readSnapshot } from "./data.js";
import { setupView, shelfSelectView, deviationsView, countingView } from "./views.js";

const app = $("app");
const today = todayKey();
const MAX_QTY = 9999;
const YES = ["oikein", "kyllä", "joo", "jep", "ok", "okei"];
const NO = ["väärin", "ei", "uudelleen", "uusiksi"];

let store;
let user = null;
let currentWorker = loadJson("wms_worker", "");
let undoStack = [];
let fbCounted = {};
let unsubscribeCounted = null;
let snapshotMeta = null;
let camera;
let voice = null; // {vnr, mode:'number'|'confirm', qty, handle}

let S = {
  phase: "setup", products: null, shelves: null, shelfStats: {}, selectedShelf: null, shelfItems: null, currentIdx: 0,
  counted: {}, allCounted: {}, camConfirmed: false, device: loadJson("wms_inventointi_device", ""),
  checkListItems: null, error: null, result: null, loading: null,
};

/* ───────── Render ───────── */
function computeShelfStats() {
  const stats = {};
  for (const p of S.products || []) {
    const st = (stats[p.shelfKey] ||= { total: 0, counted: 0 });
    st.total++;
    if (S.allCounted[p.vnr] !== undefined) st.counted++;
  }
  S.shelfStats = stats;
}

function setState(u) {
  Object.assign(S, u);
  render();
}

function viewModel() {
  return { S, workers: WORKERS, currentWorker, storeKind: store.kind, snapshotMeta, today, undoCount: undoStack.length, voiceOn: !!voice };
}

function render() {
  if (store.auth.required && !user) { hideScan(); app.innerHTML = loginHtml(S.error); return; }
  const v = viewModel();
  if (S.phase === "setup") { stopVoice(); stopCamera(); hideScan(); app.innerHTML = setupView(v); return; }
  computeShelfStats();
  if (S.phase === "shelfSelect") { stopVoice(); hideScan(); app.innerHTML = shelfSelectView(v); return; }
  if (S.phase === "deviations") { stopVoice(); hideScan(); app.innerHTML = deviationsView(v); return; }
  if (S.phase === "counting") {
    app.innerHTML = countingView(v);
    if (S.device === "scanner") showScan(); else hideScan();
  }
}

/* ───────── Skannauskenttä ja kamera ───────── */
function showScan() {
  $("scan-wrap").style.display = "block";
  const inp = $("scan-field");
  inp.placeholder = S.camConfirmed ? "Syötä määrä" : "Skannaa viivakoodi";
  if (document.activeElement !== inp && document.activeElement?.id !== "qty-input") inp.focus();
}
function hideScan() { $("scan-wrap").style.display = "none"; }

function stopCamera() {
  camera?.stop();
  $("cam-wrap").style.display = "none";
}

async function startCamera() {
  stopCamera();
  if (S.device === "scanner" || !cameraSupported()) return;
  $("cam-wrap").style.display = "block";
  try { await camera.start(); }
  catch { stopCamera(); setState({ result: { type: "fail", text: "Kamera ei käynnisty — syötä koodi käsin" } }); }
}

/* ───────── Puhe: sano määrä → vahvista "oikein"/"väärin" ───────── */
function stopVoice() { voice?.handle?.stop(); voice = null; }

function startVoice(vnr) {
  if (!speechSupported()) { setState({ result: { type: "fail", text: "Puheentunnistus ei tuettu — syötä käsin" } }); return; }
  stopVoice();
  voice = { vnr, mode: "number", qty: null, handle: null };
  voice.handle = listenText({
    onStart: () => setState({ result: { type: "ok", text: "🎤 Kuuntelen... sano määrä" } }),
    onText: onVoiceText,
    onError: (e) => { voice = null; setState({ result: { type: "fail", text: e === "mic-loop" ? "🎤 Mikrofoni ei toimi — syötä käsin" : e === "not-allowed" ? "🎤 Mikrofoni estetty" : "🎤 Virhe: " + e } }); },
  });
}

function onVoiceText(raw) {
  if (!voice) return;
  const t = raw.trim().toLowerCase();
  const { vnr } = voice;
  if (voice.mode === "number") {
    const n = parseSpokenNumber(t);
    if (n === null) { setState({ result: { type: "fail", text: `🎤 "${t}" — sano uudelleen` } }); return; }
    voice.qty = n; voice.mode = "confirm";
    setState({ result: { type: "ok", text: `🎤 ${n} — oikein vai väärin?` } });
    return;
  }
  if (YES.includes(t)) { const q = voice.qty; stopVoice(); countItem(vnr, q); return; }
  if (NO.includes(t)) { voice.mode = "number"; voice.qty = null; setState({ result: { type: "fail", text: "🎤 Peruttu — sano uudelleen" } }); return; }
  const n = parseSpokenNumber(t);
  if (n !== null) { voice.qty = n; setState({ result: { type: "ok", text: `🎤 ${n} — oikein vai väärin?` } }); return; }
  setState({ result: { type: "fail", text: `🎤 "${t}" — sano oikein tai väärin` } });
}

/* ───────── Datan lataus ───────── */
function keepCounted() { return $("keep-counted")?.checked !== false; }

async function enterProducts(products, meta) {
  snapshotMeta = meta;
  const shelves = groupShelves(products);
  const allCounted = {};
  subscribeCounted();
  setState({ products, shelves, allCounted, phase: "shelfSelect", loading: null, error: null, result: { type: "ok", text: `✓ ${products.length} tuotetta, ${shelves.length} hyllyä` } });
}

function subscribeCounted() {
  unsubscribeCounted?.();
  unsubscribeCounted = store.subscribe("inventointi/counted", (val) => {
    fbCounted = val || {};
    const all = {};
    for (const [vnr, c] of Object.entries(fbCounted)) all[vnr] = c.qty;
    S.allCounted = all;
    if (S.phase === "counting" && S.shelfItems) {
      const c = {};
      for (const i of S.shelfItems) if (all[i.vnr] !== undefined) c[i.vnr] = all[i.vnr];
      S.counted = c; // ei uudelleenpiirtoa kesken syötön (näppäimistö)
    } else if (S.phase === "shelfSelect" || S.phase === "deviations") render();
  });
}

async function loadExport() {
  setState({ loading: "Haetaan dataa...", error: null, result: null });
  try {
    const data = await fetchExport();
    await saveSnapshot(store, data, { keepCounted: keepCounted(), by: currentWorker });
    const { meta } = await readSnapshot(store);
    await enterProducts(data.products, meta);
  } catch (e) { setState({ loading: null, error: "Haku epäonnistui: " + e.message + " (vienti ei välttämättä ole vielä käytössä — kokeile tiedostoja tai tallennettua dataa)" }); }
}

async function loadSnapshot() {
  setState({ loading: "Haetaan Firebasesta...", error: null, result: null });
  try {
    const { products, meta } = await readSnapshot(store);
    if (!products.length) { setState({ loading: null, error: "Tallennettua dataa ei ole — hae tuore data ensin" }); return; }
    await enterProducts(products, meta);
  } catch (e) { setState({ loading: null, error: "Virhe: " + e.message }); }
}

async function loadFiles() {
  const maxxFile = $("maxx-file")?.files[0];
  const magFile = $("mag-file")?.files[0];
  const eanFile = $("ean-file")?.files[0] || null;
  if (!maxxFile || !magFile) { setState({ error: "Valitse Maxx-saldo ja keräilemätön -tiedostot" }); return; }
  setState({ loading: "Luetaan tiedostoja...", error: null, result: null });
  try {
    const data = await loadFromFiles(store, { maxxFile, magFile, eanFile });
    await saveSnapshot(store, data, { keepCounted: keepCounted(), by: currentWorker });
    const { meta } = await readSnapshot(store);
    await enterProducts(data.products, meta);
    if (data.noEan) setState({ result: { type: "fail", text: "⚠ EAN-koodeja ei saatu ladattua — viivakoodit eivät toimi" } });
  } catch (e) { setState({ loading: null, error: "Virhe: " + e.message }); }
}

/* ───────── Hyllyn valinta ───────── */
async function loadChecklist() {
  const f = $("checklist-file")?.files[0];
  if (!f) { setState({ error: "Valitse tiedosto" }); return; }
  const text = await f.text();
  const vnrs = text.replace(/\r/g, "").split("\n").map((l) => l.split(/[,;]/)[0].trim()).filter((v) => /^\d+$/.test(v));
  if (!vnrs.length) { setState({ error: "Ei VNR-koodeja tiedostossa" }); return; }
  const byVnr = new Map(S.products.map((p) => [p.vnr, p]));
  const items = vnrs.map((v) => byVnr.get(v)).filter(Boolean);
  if (!items.length) { setState({ error: `Yhtään VNR:ää ei löytynyt tuoterekisteristä (${vnrs.length} luettu)` }); return; }
  setState({ checkListItems: sortByRoute(items), error: null, result: { type: "ok", text: `✓ ${items.length}/${vnrs.length} tuotetta löytyi` } });
}

function selectShelf(key) {
  let items;
  if (key === "__CHECK__") {
    if (!S.checkListItems?.length) { setState({ error: "Ei tarkistettavia" }); return; }
    items = S.checkListItems;
  } else items = sortByRoute(S.products.filter((p) => p.shelfKey === key));
  const counted = {};
  for (const i of items) if (S.allCounted[i.vnr] !== undefined) counted[i.vnr] = S.allCounted[i.vnr];
  let startIdx = items.findIndex((i) => counted[i.vnr] === undefined);
  const allDone = startIdx === -1;
  if (allDone) startIdx = 0;
  undoStack = [];
  setState({
    selectedShelf: key, shelfItems: items, currentIdx: startIdx, counted, phase: "counting", camConfirmed: false, error: null,
    result: allDone ? { type: "ok", text: "✓ Kaikki inventoitu — voit tarkistaa tai palata" } : null,
  });
  if (!allDone) startCamera();
}

/* ───────── Laskenta ───────── */
function countItem(vnr, qty) {
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) { setState({ error: `Määrän pitää olla kokonaisluku 0–${MAX_QTY}` }); return; }
  const item = S.shelfItems.find((i) => i.vnr === vnr);
  undoStack.push({ vnr, prev: S.counted[vnr], idx: S.currentIdx });
  if (undoStack.length > 50) undoStack.shift();
  S.counted[vnr] = qty;
  S.allCounted[vnr] = qty;
  store.set(`inventointi/counted/${vnr}`, { qty, name: item?.name || "", location: item?.location || "", expected: item?.expected || 0, worker: currentWorker, t: Date.now(), date: todayKey() });

  const cur = S.shelfItems[S.currentIdx];
  if (cur && cur.vnr === vnr) {
    const items = S.shelfItems;
    let next = -1;
    for (let i = S.currentIdx + 1; i < items.length && next === -1; i++) if (S.counted[items[i].vnr] === undefined) next = i;
    for (let i = 0; i < S.currentIdx && next === -1; i++) if (S.counted[items[i].vnr] === undefined) next = i;
    if (next !== -1) setTimeout(() => { setState({ currentIdx: next, camConfirmed: false, error: null }); startCamera(); }, 600);
  }
  stopCamera();
  setState({ error: null, result: { type: "ok", text: `✓ ${item?.name || vnr}: ${qty} kpl` }, camConfirmed: false });
}

function undo() {
  const u = undoStack.pop();
  if (!u) return;
  const item = S.shelfItems?.find((i) => i.vnr === u.vnr);
  if (u.prev === undefined) { delete S.counted[u.vnr]; delete S.allCounted[u.vnr]; store.remove(`inventointi/counted/${u.vnr}`); }
  else {
    S.counted[u.vnr] = u.prev; S.allCounted[u.vnr] = u.prev;
    store.set(`inventointi/counted/${u.vnr}`, { qty: u.prev, name: item?.name || "", location: item?.location || "", expected: item?.expected || 0, worker: currentWorker, t: Date.now(), date: todayKey() });
  }
  setState({ currentIdx: u.idx, result: { type: "ok", text: "↩ Peruttu" } });
}

function navTo(idx) {
  if (idx < 0 || idx >= S.shelfItems.length) return;
  stopCamera(); stopVoice();
  setState({ currentIdx: idx, result: null, camConfirmed: false, error: null });
  startCamera();
}

function finishShelf() {
  stopCamera(); stopVoice(); hideScan();
  setState({ phase: "shelfSelect", selectedShelf: null, shelfItems: null, result: { type: "ok", text: "✓ Hylly valmis" }, camConfirmed: false });
}

const matchEan = (a, b) => !!a && a !== "null" && !!b && (a === b || b.endsWith(a) || a.endsWith(b));

function confirmCurrent(cur) {
  stopCamera();
  setState({ camConfirmed: true, result: { type: "ok", text: `✓ ${cur.name} — sano määrä` } });
  setTimeout(() => startVoice(cur.vnr), 300);
}

function handleCamScan(code) {
  if (!S.shelfItems) return;
  const cur = S.shelfItems[S.currentIdx];
  if (!cur) return;
  if (matchEan(cur.ean, code) || cur.vnr === code) { confirmCurrent(cur); return; }
  const other = S.shelfItems.find((i) => matchEan(i.ean, code) || i.vnr === code);
  if (other) {
    stopCamera();
    navigator.vibrate?.([200, 100, 200]);
    setState({ currentIdx: S.shelfItems.indexOf(other), camConfirmed: true, result: { type: "fail", text: `⚠ VÄÄRÄ TUOTE — vaihdettu: ${other.name}` } });
    setTimeout(() => startVoice(other.vnr), 300);
    return;
  }
  if (/^\d{1,4}$/.test(code)) { countItem(cur.vnr, parseInt(code, 10)); return; }
  setState({ result: { type: "fail", text: "EAN ei täsmää — skannaa uudelleen tai ohita" } });
}

function handleScanInput(val) {
  if (!val || !S.shelfItems) return;
  const item = S.shelfItems.find((i) => matchEan(i.ean, val) || i.vnr === val);
  if (item) setState({ currentIdx: S.shelfItems.indexOf(item), result: { type: "ok", text: "→ " + item.name } });
  else setState({ result: { type: "fail", text: "EAN/VNR ei löydy tältä hyllyltä" } });
}

// Syöte voi olla määrä (1–4 numeroa) tai viivakoodi (pidempi): pitkää numeroa ei koskaan tulkita määräksi.
function handleInput(raw) {
  const v = raw.trim();
  if (!v || S.phase !== "counting") return;
  const cur = S.shelfItems[S.currentIdx];
  if (!S.camConfirmed) { handleCamScan(v); return; }
  if (/^\d{1,4}$/.test(v)) countItem(cur.vnr, parseInt(v, 10));
  else handleScanInput(v);
}

/* ───────── Tapahtumat ───────── */
const actions = {
  login: async () => { const e = await doLogin(store, $("login-email"), $("login-pass")); setState({ error: e }); },
  device: (d) => { S.device = d.device; saveJson("wms_inventointi_device", d.device); render(); },
  "load-export": loadExport,
  "load-snapshot": loadSnapshot,
  "load-files": loadFiles,
  "back-setup": () => { unsubscribeCounted?.(); unsubscribeCounted = null; setState({ phase: "setup", products: null, shelves: null, allCounted: {}, result: null }); },
  "show-devs": () => setState({ phase: "deviations" }),
  "show-shelves": () => setState({ phase: "shelfSelect" }),
  "dl-all": () => downloadCsv("inventointi_kaikki.csv", rowsAll(S.products, fbCounted), ",", { bom: true, quoteAll: true }),
  "dl-today": (d) => downloadCsv(`inventointi_${d.today}.csv`, rowsToday(S.products, fbCounted, d.today), ",", { bom: true, quoteAll: true }),
  "dl-devs": () => downloadCsv(`erot_${today}.csv`, rowsDeviations(S.products, fbCounted), ",", { bom: true, quoteAll: true }),
  "load-checklist": loadChecklist,
  "select-shelf": (d) => selectShelf(d.key),
  "skip-scan": () => { stopCamera(); const cur = S.shelfItems[S.currentIdx]; setState({ camConfirmed: true, result: null }); if (cur) startVoice(cur.vnr); },
  "start-voice": (d) => startVoice(d.vnr),
  "stop-voice": () => { stopVoice(); render(); },
  nav: (d) => navTo(S.currentIdx + parseInt(d.delta, 10)),
  goto: (d) => navTo(parseInt(d.idx, 10)),
  undo: () => { stopVoice(); undo(); },
  "finish-shelf": finishShelf,
};

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el.dataset, el);
});
app.addEventListener("change", (e) => {
  const el = e.target.closest("[data-change]");
  if (el?.dataset.change === "worker") { currentWorker = el.value; saveJson("wms_worker", currentWorker); }
});
app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target.id !== "qty-input") return;
  e.preventDefault();
  const v = e.target.value;
  e.target.value = "";
  handleInput(v);
});
$("scan-field").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const v = e.target.value;
  e.target.value = "";
  handleInput(v);
});

window.addEventListener("beforeunload", (e) => {
  if (S.phase === "counting") { e.preventDefault(); e.returnValue = "Inventointi on kesken."; }
});

/* ───────── Käynnistys: ei dataa haeta ennen kuin käyttäjä käynnistää haun ───────── */
async function init() {
  store = await createStore();
  camera = createCamera({ video: $("cam-video"), flash: $("cam-flash"), onCode: handleCamScan });
  store.auth.onChange(async (u) => {
    user = u;
    if (u && S.phase === "setup" && !snapshotMeta) {
      try { snapshotMeta = (await store.get("inventointi/meta")) || null; } catch { /* ei metatietoa */ }
    }
    render();
  });
  render();
}

init();
