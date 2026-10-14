// Siirrot: hyllypaikkojen optimointi (keräily → hyllytys). Portattu siirtoapista.
// Muutokset alkuperäiseen: yhteinen kirjasto, kunnollinen CSV-parseri, HTML-escape,
// tila avainnettu (sku|from|to) jotta vanha tila ei piilota uutta ehdotusta, vahvistus ennen nollausta.
import { cmpSerpentine, sizeDiff } from "../../lib/locations.js";
import { parseCsvObjects, pick, hasColumn, fetchCsvText } from "../../lib/csv.js";
import { loadJson, saveJson, removeKeys } from "../../lib/storage.js";
import { esc, $, show } from "../../lib/ui.js";

const CSV_URL = "https://storage.googleapis.com/olo-export-data/export_siirtoehdotus_app000000000000.csv";
const KEY_DONE = "wms_siirrot_done";
const KEY_SKIP = "wms_siirrot_skip";
const KEY_PHASE = "wms_siirrot_phase";
const NO_TARGET = ["ok", "uusi", "", "vanha", "not available"];

let allItems = [];
let activeItems = [];
let phase = "pick";
const doneSet = new Set();
const skipSet = new Set();

const itemKey = (it) => `${it.sku}|${it.from}|${it.to}`;

function saveState() {
  saveJson(KEY_DONE, [...doneSet]);
  saveJson(KEY_SKIP, [...skipSet]);
  saveJson(KEY_PHASE, phase);
}

function loadState() {
  doneSet.clear();
  skipSet.clear();
  loadJson(KEY_DONE, []).forEach((k) => doneSet.add(k));
  loadJson(KEY_SKIP, []).forEach((k) => skipSet.add(k));
  phase = loadJson(KEY_PHASE, "pick") === "put" ? "put" : "pick";
}

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

function isHandled(it) {
  const k = itemKey(it);
  return doneSet.has(k) || skipSet.has(k);
}

function sortedItems() {
  const field = phase === "pick" ? "from" : "to";
  return [...activeItems].sort((a, b) => cmpSerpentine(a[field], b[field]));
}

function renderCards() {
  const container = $("cards-container");
  const summary = $("summary-view");
  const total = activeItems.length;
  const handled = activeItems.filter(isHandled).length;

  if (total > 0 && handled === total) {
    container.innerHTML = "";
    show(summary, true);
    const pickDone = phase === "pick";
    $("sum-title").textContent = pickDone ? "✅ Keräily valmis!" : "🎉 Hyllytys valmis!";
    $("sum-sub").textContent = pickDone
      ? "Kaikki tuotteet kärryyn. Aloita hyllytyslenkki."
      : "Kaikki tuotteet uusille paikoilleen.";
    $("sum-done").textContent = activeItems.filter((it) => doneSet.has(itemKey(it))).length;
    $("sum-skip").textContent = activeItems.filter((it) => skipSet.has(itemKey(it))).length;
    const next = $("next-phase-btn");
    if (pickDone) { next.textContent = "Aloita hyllytyslenkki →"; next.onclick = nextPhase; }
    else { next.textContent = "Uusi lenkki"; next.onclick = resetSession; }
    return;
  }
  show(summary, false);

  const putMode = phase === "put";
  container.innerHTML = sortedItems().map((it, i) => {
    const handledNow = isHandled(it);
    const loc = putMode ? it.to : it.from;
    return `<div class="card${handledNow ? " done" : ""}">
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
      ${handledNow ? "" : `<div class="btn-row">
        <button class="btn skip-btn" data-act="skip" data-key="${esc(itemKey(it))}">✕ Ohita</button>
        <button class="btn primary" data-act="done" data-key="${esc(itemKey(it))}">${putMode ? "✓ Hyllytetty" : "✓ Kerätty"}</button>
      </div>`}
    </div>`;
  }).join("");
}

function updateProgress() {
  const total = activeItems.length;
  const done = activeItems.filter(isHandled).length;
  $("prog").style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
  $("done-count").textContent = `${done} / ${total}`;
}

function setPhase(p) {
  phase = p;
  saveState();
  $("btn-pick").classList.toggle("active", p === "pick");
  $("btn-put").classList.toggle("active", p === "put");
  $("phase-label").textContent = (p === "pick" ? "Keräilylenkki" : "Hyllytyslenkki") + " — serpentiinijärjestys";
  show($("summary-view"), false);
  renderCards();
  updateProgress();
}

function reloadItems() {
  const n = parseInt($("count-sel").value, 10) || 20;
  activeItems = allItems.slice(0, n);
  setPhase(phase);
}

function mark(key, kind) {
  if (kind === "done") { doneSet.add(key); skipSet.delete(key); }
  else { skipSet.add(key); doneSet.delete(key); }
  saveState();
  updateProgress();
  renderCards();
}

function nextPhase() {
  doneSet.clear();
  setPhase("put");
}

function resetSession() {
  if (!confirm("Aloitetaanko uusi lenkki? Nykyinen eteneminen nollataan.")) return;
  doneSet.clear();
  skipSet.clear();
  removeKeys(KEY_DONE, KEY_SKIP, KEY_PHASE);
  setPhase("pick");
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
    loadState();
    show($("loading-view"), false);
    show($("main-view"), true);
    reloadItems();
  } catch (err) {
    $("load-error").textContent = "Virhe: " + err.message;
    show($("load-error"), true);
    show($("retry-btn"), true, "inline-block");
  }
}

$("btn-pick").addEventListener("click", () => setPhase("pick"));
$("btn-put").addEventListener("click", () => setPhase("put"));
$("count-sel").addEventListener("change", reloadItems);
$("reset-btn").addEventListener("click", resetSession);
$("retry-btn").addEventListener("click", fetchData);
$("cards-container").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (btn) mark(btn.dataset.key, btn.dataset.act);
});

fetchData();
