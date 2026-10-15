// Siirrot: hyllypaikkojen optimointi (keräily + hyllytys). Portattu siirtoapista (lähteet/siirtoappi-main).
// Muutokset alkuperäiseen: yhteinen kirjasto, kunnollinen CSV-parseri, HTML-escape,
// tila avainnettu (sku|from|to) jotta vanha tila ei piilota uutta ehdotusta, vahvistus ennen nollausta.
// Jaettu tila: useampi työntekijä ottaa omat erät (varaus), ja tila kulkee Firebasen kautta reaaliajassa
// (sessions/{pvm}/siirrot/{avain}). Toinen työntekijä ei saa samaa siirtoa, ja kaikki näkevät etenemisen.
import { cmpSerpentine, sizeDiff } from "../../lib/locations.js";
import { parseCsvObjects, pick, hasColumn, fetchCsvText } from "../../lib/csv.js";
import { loadJson, saveJson } from "../../lib/storage.js";
import { esc, $, show } from "../../lib/ui.js";
import { createStore, todayKey } from "../../lib/store/index.js";
import { loginHtml, doLogin } from "../../lib/auth-ui.js";
import { WORKERS } from "../../config/workers.js";

const CSV_URL = "https://storage.googleapis.com/olo-export-data/export_siirtoehdotus_app000000000000.csv";
const KEY_PHASE = "wms_siirrot_phase";
const KEY_BATCH = "wms_siirrot_batch";
const CLAIM_TTL = 90 * 60 * 1000; // vapauttamaton varaus vanhenee 90 min kuluttua
// "tyhjä" = sopivaa vapaata paikkaa ei löytynyt, "dimensiot" = mitat puuttuvat, "n/a" = ei tietoa: ei kohdepaikkaa, joten ei siirrettävä
const NO_TARGET = ["ok", "uusi", "", "vanha", "not available", "tyhjä", "dimensiot", "n/a"];

let store, user = null, unsub = null;
let me = loadJson("wms_worker", "");
let batch = loadJson(KEY_BATCH, ""); // oman erän tunniste
let phase = loadJson(KEY_PHASE, "pick") === "put" ? "put" : "pick";
let allItems = [];
let shared = {}; // avain -> {state: claimed|picked|placed|skipped, by, t, batch}

const itemKey = (it) => `${it.sku}|${it.from}|${it.to}`;
const fbKey = (k) => k.replace(/[.#$/[\]]/g, "_");
const basePath = () => `sessions/${todayKey()}/siirrot`;
const rec = (it) => shared[fbKey(itemKey(it))];

export function parseSiirtoCsv(text) {
  const rows = parseCsvObjects(text);
  if (!rows.length) return [];
  if (!hasColumn(rows[0], "storage_location", "Hyllypaikka") ||
      !hasColumn(rows[0], "proposed_storage_location", "Ehdotus")) return [];

  const items = [];
  for (const r of rows) {
    const from = pick(r, "storage_location", "Hyllypaikka");
    const to = pick(r, "proposed_storage_location", "Ehdotus");
    if (NO_TARGET.includes(to.toLowerCase()) || to === from || to.length < 4) continue;
    const koko = pick(r, "paikan_koko", "koko");
    const opt = pick(r, "required_size", "Opt. koko");
    items.push({ sku: pick(r, "sku"), name: pick(r, "name"), from, to, koko, opt, diff: sizeDiff(koko, opt) });
  }
  items.sort((a, b) => b.diff - a.diff || cmpSerpentine(a.from, b.from));
  return items;
}

/* ───────── Tilat ───────── */
// Vapaa = ei kenenkään varaama (tai varaus on vanhentunut)
function isFree(it) {
  const r = rec(it);
  return !r || (r.state === "claimed" && Date.now() - (r.t || 0) > CLAIM_TTL);
}
const isMine = (it) => { const r = rec(it); return !!r && r.by === me && r.batch === batch; };
const myItems = () => allItems.filter(isMine);
const stateOf = (it) => rec(it)?.state;

// Näytettävä lista vaiheen mukaan: keräilyssä kaikki omat, hyllytyksessä omat kerätyt
function phaseItems() {
  const mine = myItems();
  return phase === "pick" ? mine : mine.filter((it) => ["picked", "placed"].includes(stateOf(it)));
}
function isHandled(it) {
  const s = stateOf(it);
  return phase === "pick" ? s !== "claimed" : s === "placed";
}
function sortedItems() {
  const field = phase === "pick" ? "from" : "to";
  return [...phaseItems()].sort((a, b) => cmpSerpentine(a[field], b[field]));
}

/* ───────── Kirjoitukset ───────── */
const write = (it, state) =>
  store.set(`${basePath()}/${fbKey(itemKey(it))}`, { state, by: me, t: Date.now(), batch });

async function takeBatch() {
  if (!me) { alert("Valitse ensin käyttäjä"); return; }
  const n = parseInt($("count-sel").value, 10) || 20;
  const picks = allItems.filter(isFree).slice(0, n);
  if (!picks.length) { alert("Ei vapaita siirtoja"); return; }
  batch = Date.now().toString(36);
  saveJson(KEY_BATCH, batch);
  await Promise.all(picks.map((it) => write(it, "claimed")));
  // Tarkista varaus: jos joku ehti ylikirjoittaa, kohde putoaa listalta tilauksen päivityttyä (isMine vaatii by + batch)
  setPhase("pick");
}

async function mark(key, kind) {
  const it = allItems.find((x) => itemKey(x) === key);
  if (!it) return;
  if (kind === "skip") await write(it, "skipped");
  else await write(it, phase === "pick" ? "picked" : "placed");
}

async function releaseUnpicked() {
  const open = myItems().filter((it) => stateOf(it) === "claimed");
  if (!open.length) return;
  if (!confirm(`Vapautetaanko ${open.length} keräämätöntä siirtoa muille?`)) return;
  await Promise.all(open.map((it) => store.remove(`${basePath()}/${fbKey(itemKey(it))}`)));
}

function nextPhase() { setPhase("put"); }

function resetSession() {
  if (!confirm("Aloitetaanko uusi lenkki? Nykyinen erä päättyy (siirtojen tiedot jäävät talteen).")) return;
  batch = "";
  saveJson(KEY_BATCH, "");
  setPhase("pick");
}

/* ───────── Näkymä ───────── */
function teamStrip() {
  const todays = allItems.map((it) => rec(it)).filter(Boolean);
  const byPerson = {};
  let placed = 0, skipped = 0;
  for (const r of todays) {
    if (r.state === "placed") placed++;
    else if (r.state === "skipped") skipped++;
    else if (r.state === "claimed" && Date.now() - r.t > CLAIM_TTL) continue;
    else byPerson[r.by] = (byPerson[r.by] || 0) + 1;
  }
  const free = allItems.filter(isFree).length;
  const others = Object.entries(byPerson).filter(([n]) => n !== me).map(([n, c]) => `${esc(n)} ${c}`).join(" · ");
  return `Vapaana <b>${free}</b> · valmiina <b>${placed}</b>${skipped ? ` · ohitettu ${skipped}` : ""}${others ? ` · muilla: ${others}` : ""}`;
}

function renderCards() {
  const container = $("cards-container");
  const summary = $("summary-view");
  const take = $("take-view");
  const list = phaseItems();
  $("team-strip").innerHTML = teamStrip();

  const hasBatch = myItems().length > 0;
  show(take, !hasBatch);
  $("release-btn").style.display = hasBatch && myItems().some((it) => stateOf(it) === "claimed") ? "" : "none";
  if (!hasBatch) { container.innerHTML = ""; show(summary, false); return; }

  const handled = list.filter(isHandled).length;
  if (list.length > 0 && handled === list.length) {
    container.innerHTML = "";
    show(summary, true);
    const pickDone = phase === "pick";
    $("sum-title").textContent = pickDone ? "Keräily valmis!" : "Hyllytys valmis!";
    $("sum-sub").textContent = pickDone
      ? "Kaikki tuotteet kärryyn. Aloita hyllytyslenkki."
      : "Kaikki tuotteet uusille paikoilleen.";
    $("sum-done").textContent = myItems().filter((it) => ["picked", "placed"].includes(stateOf(it))).length;
    $("sum-skip").textContent = myItems().filter((it) => stateOf(it) === "skipped").length;
    const next = $("next-phase-btn");
    if (pickDone) { next.textContent = "Aloita hyllytyslenkki →"; next.onclick = nextPhase; }
    else { next.textContent = "Uusi lenkki"; next.onclick = resetSession; }
    return;
  }
  show(summary, false);

  if (!list.length) {
    container.innerHTML = `<div class="loading"><div class="msg">Ei kerättyjä siirtoja hyllytettäväksi. Palaa Keräilyyn.</div></div>`;
    return;
  }
  const putMode = phase === "put";
  container.innerHTML = sortedItems().map((it, i) => {
    const handledNow = isHandled(it);
    const loc = putMode ? it.to : it.from;
    const skipped = stateOf(it) === "skipped";
    return `<div class="card${handledNow || skipped ? " done" : ""}">
      <div class="card-top">
        <span class="card-idx">${i + 1}</span>
        <div style="flex:1"><div class="card-name">${esc(it.name)}</div><div class="card-sku">SKU ${esc(it.sku)}</div></div>
        ${it.diff > 0 ? `<span class="diff-badge">Δ${it.diff}</span>` : ""}
      </div>
      <div class="location-box ${putMode ? "to" : "from"}">
        <div class="loc-label">${putMode ? "Uusi hyllypaikka" : "Hyllypaikka (nykyinen)"}</div>
        <div class="loc-code">${esc(loc)}</div>
      </div>
      <div class="size-info">Koko: <strong>${esc(it.koko || "?")}</strong><span class="arrow">→</span><strong style="color:#1e5f49">${esc(it.opt || "?")}</strong></div>
      ${handledNow || skipped ? "" : `<div class="btn-row">
        <button class="btn skip-btn" data-act="skip" data-key="${esc(itemKey(it))}">✕ Ohita</button>
        <button class="btn primary" data-act="done" data-key="${esc(itemKey(it))}">${putMode ? "✓ Hyllytetty" : "✓ Kerätty"}</button>
      </div>`}
    </div>`;
  }).join("");
}

function updateProgress() {
  const list = phaseItems();
  const done = list.filter(isHandled).length;
  $("prog").style.width = (list.length ? Math.round((done / list.length) * 100) : 0) + "%";
  $("done-count").textContent = `${done} / ${list.length}`;
}

function refresh() { renderCards(); updateProgress(); }

function setPhase(p) {
  phase = p;
  saveJson(KEY_PHASE, p);
  $("btn-pick").classList.toggle("active", p === "pick");
  $("btn-put").classList.toggle("active", p === "put");
  $("phase-label").textContent = (p === "pick" ? "Keräilylenkki" : "Hyllytyslenkki") + " — serpentiinijärjestys";
  show($("summary-view"), false);
  refresh();
}

/* ───────── Käynnistys ───────── */
function subscribeShared() {
  unsub?.();
  unsub = store.subscribe(basePath(), (val) => { shared = val || {}; if (allItems.length) refresh(); });
}

function renderWorkerSelect() {
  const sel = $("worker-sel");
  sel.innerHTML = `<option value="">— Käyttäjä —</option>` + WORKERS.map((w) => `<option value="${esc(w)}"${w === me ? " selected" : ""}>${esc(w)}</option>`).join("");
}

async function fetchData() {
  show($("loading-view"), true);
  show($("main-view"), false);
  show($("load-error"), false);
  show($("retry-btn"), false);
  try {
    const items = parseSiirtoCsv(await fetchCsvText(CSV_URL));
    if (!items.length) throw new Error("CSV ei tuottanut siirrettäviä tuotteita");
    allItems = items;
    show($("loading-view"), false);
    show($("main-view"), true);
    renderWorkerSelect();
    subscribeShared();
    setPhase(phase);
  } catch (err) {
    $("load-error").textContent = "Virhe: " + err.message;
    show($("load-error"), true);
    show($("retry-btn"), true, "inline-block");
  }
}

function showLogin(error) {
  show($("loading-view"), false);
  show($("main-view"), false);
  const el = $("login-view");
  el.innerHTML = loginHtml(error);
  show(el, true);
}

$("btn-pick").addEventListener("click", () => setPhase("pick"));
$("btn-put").addEventListener("click", () => setPhase("put"));
$("take-btn").addEventListener("click", takeBatch);
$("release-btn").addEventListener("click", releaseUnpicked);
$("reset-btn").addEventListener("click", resetSession);
$("retry-btn").addEventListener("click", fetchData);
$("worker-sel").addEventListener("change", (e) => { me = e.target.value; saveJson("wms_worker", me); refresh(); });
$("cards-container").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (btn) mark(btn.dataset.key, btn.dataset.act);
});
$("login-view").addEventListener("click", async (e) => {
  if (e.target.closest('[data-action="login"]')) {
    const err = await doLogin(store, $("login-email"), $("login-pass"));
    if (err) showLogin(err);
  }
});

(async function init() {
  store = await createStore();
  store.auth.onChange((u) => {
    user = u;
    if (store.auth.required && !user) { showLogin(null); return; }
    show($("login-view"), false);
    fetchData();
  });
})();
