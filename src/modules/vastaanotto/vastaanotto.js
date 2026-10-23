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
import { parseOrderWorkbook, buildRec, summarize, lineKey, lineStatus, buildXml, xmlFileName, splitToCarts, placement } from "./domain.js";
import { startView, orderView, deviationRows } from "./views.js";

const GCS_CSV = "https://storage.googleapis.com/olo-export-data/hyllytys-app-export000000000000.csv";
const YES = ["oikein", "kyllä", "joo", "jep", "ok", "okei"];
const NO = ["väärin", "ei", "uudelleen", "uusiksi"];
const app = $("app");

let store, user = null, camera = null;
let currentWorker = loadJson("wms_worker", "");
let autoShip = loadJson("wms_vastaanotto_autoship", true); // tilauksen valmistuttua kärryt siirtyvät automaattisesti hyllytykseen
let completing = false;
let autoVoice = loadJson("wms_vastaanotto_autovoice", false); // puhe käynnistyy itsestään skannauksen jälkeen
let recent = [];
let unsub = null;
let voice = null; // {key, mode, pending, handle}
let renderTimer = null;

let S = {
  phase: "start", order: null, recs: {}, tab: "lines", filter: "open", selectedKey: null, error: null, result: null, loading: null,
  master: null, masterError: null, masterLoading: false, voiceCandidate: null, voiceText: null, draft: { key: null, qty: null, end: null }, drafts: {}, shelvingSentAt: null, xmlAt: null, arrival: null, completion: null, priority: null, showDone: false,
};

/* ───────── Render (säilyttää kentän fokuksen) ───────── */
function viewModel() {
  return {
    S, workers: WORKERS, currentWorker, storeKind: store.kind, recent, voiceOn: !!voice, autoVoice, autoShip,
    camOk: cameraSupported(), camOn: !!camera?.running, dirOk: typeof window.showDirectoryPicker === "function",
    xmlName: S.order ? xmlFileName(S.order.supplier, S.order.orderDate) : "",
  };
}

// Skannauksen jälkeen avattu rivi pidetään näkyvissä, vaikka näkymä piirtyisi uudelleen (Firebase-päivitykset, hyllypaikkojen lataus).
// Ilman tätä focus() palautti skannauskentän ja sivu hyppäsi ylös, jolloin työntekijä joutui skrollaamaan riville itse.
let scrollTarget = null; // {key, until}
let focusScanNext = false;
function applyScroll() {
  if (!scrollTarget || Date.now() > scrollTarget.until) { scrollTarget = null; return false; }
  const el = $("line-" + scrollTarget.key);
  if (!el) return false;
  el.scrollIntoView({ block: "start" });
  return true;
}

function render() {
  const y = window.scrollY;
  const active = document.activeElement;
  const keep = active && app.contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  if (store.auth.required && !user) { app.innerHTML = loginHtml(S.error); return; }
  app.innerHTML = S.phase === "order" && S.order ? orderView(viewModel()) : startView(viewModel());
  if (keep) {
    const el = $(keep.id);
    if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.start, keep.end); } catch { /* ei tekstikenttä */ } }
  }
  // Rivin kirjaamisen jälkeen kohdistus takaisin skannauskenttään: seuraava tuote voidaan skannata heti
  if (S.phase === "order" && S.order && !document.querySelector(".login") && (focusScanNext || (!S.selectedKey && (!document.activeElement || document.activeElement === document.body)))) {
    $("scan-field")?.focus({ preventScroll: true });
    focusScanNext = false;
  }
  saveDrafts();
  if (!applyScroll()) window.scrollTo(0, y);
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
      arrival: o.arrival?.t || null, completion: o.completion?.t || null, started: Object.keys(o.rec || {}).length > 0, priority: o.priority || null,
      isDone: !!o.completion || (Object.keys(o.lines || {}).length > 0 && Object.values(o.rec || {}).filter(isLineDone).length === Object.keys(o.lines || {}).length),
    }));
    // Järjestys purun priorisointia varten: saapuneet purkua odottamassa (vanhin ensin), kesken, ei vielä saapunut, valmiit
    const grp = (o) => (o.completion ? 3 : o.started ? 1 : o.arrival ? 0 : 2);
    const prio = (o) => (o.priority && !o.completion ? 0 : 1); // ostajan priorisoimat keskeneräiset tilaukset kärkeen
    recent.sort((a, b) => prio(a) - prio(b) || (prio(a) === 0 ? a.priority.t - b.priority.t : 0) || grp(a) - grp(b) || (grp(a) === 0 ? a.arrival - b.arrival : grp(a) === 3 ? b.completion - a.completion : b.loadedAt - a.loadedAt));
    recent = recent.slice(0, 40);
  } catch { recent = []; }
}

function openOrder(id) {
  unsub?.();
  unsub = store.subscribe(`vastaanotto/${id}`, (val) => {
    if (!val?.meta) return;
    const lines = Object.entries(val.lines || {}).map(([k, l]) => ({ ...l })).sort((a, b) => (a.n || 0) - (b.n || 0));
    const recs = {};
    for (const [k, r] of Object.entries(val.rec || {})) { const rec = buildRec(r); if (rec) recs[k] = rec; }
    const firstLoad = !S.order || S.order.id !== id;
    if (firstLoad) { S.drafts = {}; S.draft = { key: null, qty: null, end: null }; }
    S.order = { id, supplier: val.meta.supplier, orderDate: val.meta.orderDate, fileName: val.meta.fileName || "", updatedAt: val.meta.updatedAt || null, lines };
    S.recs = recs;
    if (firstLoad) restoreDrafts(id);
    S.shelvingSentAt = val.shelving?.t || null;
    S.xmlAt = val.xmlAt || null;
    S.arrival = val.arrival || null;
    S.completion = val.completion || null;
    S.priority = val.priority || null;
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
  checkCompletion();
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

// Keskeneräiset (kirjaamattomat) laatikon tiedot muistetaan riveittäin: toiseen riviin siirtyminen tai sivun uudelleenlataus ei hävitä syötettyä määrää.
const useDraft = (key) => {
  const d = (S.drafts[key] ||= { key, qty: null, end: S.recs[key]?.batches?.at(-1)?.end ?? null });
  S.draft = d;
  return d;
};
const resetDraft = (key) => { delete S.drafts[key]; useDraft(key); };

const DRAFT_KEY = "wms_vastaanotto_draft";
function saveDrafts() {
  if (!S.order) return; // aloitusnäkymässä ei kirjoiteta yli
  try {
    const keep = {};
    for (const [k, d] of Object.entries(S.drafts)) if (d.qty !== null && d.qty !== undefined) keep[k] = { qty: d.qty, end: d.end };
    saveJson(DRAFT_KEY, S.order && Object.keys(keep).length ? { order: S.order.id, drafts: keep, selectedKey: S.selectedKey, t: Date.now() } : null);
  } catch { /* tallennus on lisä */ }
}
function restoreDrafts(orderId) {
  const d = loadJson(DRAFT_KEY, null);
  if (!d || d.order !== orderId || Date.now() - (d.t || 0) > 12 * 3600 * 1000) return;
  for (const [k, v] of Object.entries(d.drafts || {})) if (lineByKey(k)) S.drafts[k] = { key: k, qty: v.qty, end: v.end ?? null };
  if (d.selectedKey && S.drafts[d.selectedKey]) { S.selectedKey = d.selectedKey; S.draft = S.drafts[d.selectedKey]; }
}
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
  scrollTarget = null;
  focusScanNext = true;
  const sum = st === "none" ? " — ei tullut" : ` (yhteensä ${rec.qty}/${l.ordered})`;
  setState({
    selectedKey: null, voiceCandidate: null, error: null,
    result: { type: "ok", text: `✓ ${l.name}${what ? " " + what : ""}${sum}${p ? " → " + p.label + (p.aisle ? " (levy " + p.aisle + ")" : "") : ""}` },
  });
  checkCompletion();
  return true;
}

// Kun kaikki tilauksen rivit on käsitelty: merkitään tilaus valmiiksi ja (valinnan mukaan) siirretään tuotteet ja kärryt automaattisesti hyllytykseen.
async function checkCompletion() {
  if (!S.order || S.completion || completing) return;
  const sum = summarize(S.order.lines, S.recs);
  if (sum.pending + sum.needsDate > 0) return;
  completing = true;
  try {
    S.completion = { t: Date.now(), by: currentWorker };
    await store.set(`vastaanotto/${S.order.id}/completion`, S.completion);
    if (autoShip) await toShelving({ auto: true });
  } finally { completing = false; }
}

async function markArrived(id) {
  if (!currentWorker) { setState({ error: "Valitse ensin käyttäjä" }); return; }
  await store.set(`vastaanotto/${id}/arrival`, { t: Date.now(), by: currentWorker });
  if (S.phase !== "order") { await loadRecent(); scheduleRender(); }
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
  useDraft(key);
  scrollTarget = { key, until: Date.now() + 2500 };
  setState({ selectedKey: key, voiceCandidate: null });
}
/* ───────── Puhe: määrä → vahvistus → päiväys → vahvistus ───────── */
function stopVoice() { voice?.handle?.stop(); voice = null; S.voiceText = null; S.voiceCandidate = null; }

// Virhekoodit ihmisen luettavaksi: käsipäätteellä on vaikea arvata, miksi mikrofoni ei käynnisty
function voiceErrorText(e) {
  const map = {
    "not-allowed": "Mikrofoni on estetty. Salli mikrofoni selaimen sivuasetuksista (lukkokuvake osoiterivillä) ja yritä uudelleen.",
    "service-not-allowed": "Selain ei salli puheentunnistusta tälle sivulle. Käytä Chromea ja salli mikrofoni.",
    "audio-capture": "Mikrofonia ei löydy tai se on toisen sovelluksen käytössä.",
    "network": "Puheentunnistus tarvitsee verkkoyhteyden. Tarkista Wi-Fi.",
    "language-not-supported": "Suomen kielen puheentunnistus ei ole käytettävissä tässä selaimessa.",
    "not-supported": "Tämä selain ei tue puheentunnistusta. Käytä Chromea.",
    "mic-loop": "Mikrofoni sammuu heti uudelleen. Tarkista lupa tai syötä käsin.",
  };
  return (map[e] || "Puhevirhe: " + e);
}

function startVoice(key) {
  if (!speechSupported()) { setState({ error: voiceErrorText("not-supported") }); return; }
  stopVoice();
  voice = { key, mode: "qty", pending: null, qty: null, handle: null };
  voice.handle = listenText({
    onText: onVoiceText,
    onError: (e) => { voice = null; setState({ voiceText: null, error: voiceErrorText(e) }); },
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
  // "Ei päiväystä" tunnistetaan väljästi: puheentunnistus kuulee sen usein muodossa "ei päivystä", "ei päiväys", "ei päivämäärää",
  // "ei ole" tai "päiväystä ei". Mikään päiväyssana ei ala sanalla "ei" tai "ilman", joten niillä alkava lause tarkoittaa aina "ei päiväystä".
  const clean = t.replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(ei|eipä|ilman)(\s|$)/.test(clean) || /\b(ei|ilman)\s+(päiv|paiv|pvm)/.test(clean) || /^(päiväystä|päivämäärää|pvm)\s+(ei|puuttuu)$/.test(clean)) { commitVoice(""); return; }
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
  if (autoVoice && speechSupported()) startVoice(key); // skannaus on käyttäjän toiminto, joten mikrofoni saa käynnistyä
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

async function toShelving(opts = {}) {
  const auto = !!opts.auto;
  if (!S.master) { await loadMaster(); if (!S.master) { if (auto) setState({ error: "Tilaus on valmis, mutta hyllypaikkoja ei saatu ladattua: paina Kärryt → Siirrä hyllytykseen" }); return; } }
  const { items, groups } = splitToCarts(S.order.lines, S.recs, S.master);
  if (!items.length) { setState({ error: auto ? null : "Ei saapuneita tuotteita vietäväksi", ...(auto ? { result: { type: "ok", text: "✓ Tilaus valmis (ei saapuneita tuotteita hyllytettäväksi)" } } : {}) }); return; }
  if (!auto && !confirm(`Viedäänkö ${items.length} tuotetta hyllytykseen? Ne ilmestyvät Hyllytyksen kärryihin.`)) return;
  const sscc = `TT-${S.order.id}`;
  const box = {
    sscc, by: "vastaanotto", t: Date.now(),
    items: items.map((i) => ({ vnr: i.vnr, altVnr: "", name: i.name, ean: i.ean || "", qty: i.qty, location: i.location, cartId: i.cartId, physAisle: i.physAisle, ...(i.exp?.length ? { exp: i.exp } : {}) })),
  };
  await store.set(`sessions/${todayKey()}/scannedBoxes/${boxKey(sscc)}`, box);
  await store.set(`vastaanotto/${S.order.id}/shelving`, { t: Date.now() });
  if (auto) {
    // Suljetaan kärryerät, joihin tämän tilauksen tuotteita tuli: kärryt ovat heti valittavissa Hyllytyksessä ("Kärry valmis → Hyllytykseen")
    const t = Math.max(Date.now(), box.t + 1);
    const carts = groups.filter((g) => g.kind === "cart" && g.items.length);
    await Promise.all(carts.map((g) => store.set(`sessions/${todayKey()}/cartBatches/${g.id}/${t.toString(36)}${g.id}`, { by: "vastaanotto", t })));
    setState({ error: null, result: { type: "ok", text: `✓ Tilaus valmis: ${items.length} tuotetta siirretty hyllytykseen${carts.length ? ", kärryt " + carts.map((g) => g.name).join(", ") + " valittavissa Hyllytyksessä" : ""}.` } });
    return;
  }
  setState({ error: null, result: { type: "ok", text: `✓ ${items.length} tuotetta viety hyllytykseen. Avaa Hyllytys → Lataa tiedot ja paina kärryn kohdalla "Kärry valmis → Hyllytykseen".` } });
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
  "toggle-cam": toggleCamera,  "load-master": loadMaster,
  "to-shelving": () => toShelving(),
  "toggle-done": () => setState({ showDone: !S.showDone }),
  "mark-arrived": (d) => markArrived(d.id),
  "prio-on": async (d) => {
    if (!currentWorker) { setState({ error: "Valitse ensin käyttäjä" }); return; }
    await store.set(`vastaanotto/${d.id}/priority`, { t: Date.now(), by: currentWorker });
    if (S.phase !== "order") { await loadRecent(); scheduleRender(); }
  },
  "prio-off": async (d) => { await store.remove(`vastaanotto/${d.id}/priority`); if (S.phase !== "order") { await loadRecent(); scheduleRender(); } },
  "clear-arrived": async (d) => { if (confirm("Poistetaanko saapumismerkintä?")) { await store.remove(`vastaanotto/${d.id}/arrival`); if (S.phase !== "order") { await loadRecent(); scheduleRender(); } } },
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
  if (t.dataset.change === "auto-ship") { autoShip = t.checked; saveJson("wms_vastaanotto_autoship", autoShip); return; }
  if (t.dataset.change === "auto-voice") { autoVoice = t.checked; saveJson("wms_vastaanotto_autovoice", autoVoice); if (!autoVoice) stopVoice(); scheduleRender(); return; }
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
  saveDrafts();
});

function submitScan(f) {
  const v = f.value; f.value = ""; handleScan(v);
  // Luetun koodin jälkeen näppäimistö laskeutuu; se nostetaan uudelleen kentälle, kun seuraava skannaus on tulossa (ei heti)
  f.blur();
  setTimeout(() => { if (S.phase === "order" && S.order && !S.selectedKey) $("scan-field")?.focus({ preventScroll: true }); }, 1200);
}
// Käsipääte voi kirjoittaa koodin kenttään ilman Enter-painallusta: kun kenttään ei tule uusia merkkejä 250 ms:iin ja koodi on
// vähintään 8 merkkiä (EAN), se käsitellään kuin Enter. Käsin kirjoitetut lyhyet koodit vaativat Enterin.
let autoSubmitTimer = null;
app.addEventListener("input", (e) => {
  if (e.target.id !== "scan-field") return;
  clearTimeout(autoSubmitTimer);
  const f = e.target;
  autoSubmitTimer = setTimeout(() => { if (f.isConnected && f.value.trim().length >= 8) submitScan(f); }, 250);
});
// Varmistus: osa päätteistä asettaa tekstin kenttään ilman input-tapahtumaa, joten kentän arvoa seurataan myös ajastimella.
let polledVal = "", polledAt = 0;
setInterval(() => {
  const f = $("scan-field");
  if (!f || S.phase !== "order" || !S.order) return;
  const v = f.value;
  if (v !== polledVal) { polledVal = v; polledAt = Date.now(); return; }
  if (v.trim().length >= 8 && Date.now() - polledAt >= 250) { polledVal = ""; submitScan(f); }
}, 100);
app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "scan-field") { e.preventDefault(); submitScan(e.target); return; }
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
