// Dimensiot: tuotteiden pakkausmittojen (K×P×L cm) syöttö tilausmäärän mukaisessa järjestyksessä.
// Portattu dimensioapista. Tulos viedään CSV:nä PIM-tuontia varten (ei kirjoitusta takaisin järjestelmiin).
// Muutokset alkuperäiseen: yhteinen kirjasto, kunnollinen CSV-parseri, HTML-escape,
// validointi (>0, desimaalipilkku sallittu), keskeneräiset syötteet säilyvät uudelleenpiirrossa,
// vahvistus ennen nollausta. Vienti sisältää kaikki tallennetut mittaukset (myös Top N -valinnan ulkopuoliset).
import { cmpSerpentine } from "../../lib/locations.js";
import { parseCsvObjects, pick, hasColumn, fetchCsvText, downloadCsv } from "../../lib/csv.js";
import { loadJson, saveJson, removeKeys } from "../../lib/storage.js";
import { esc, $, show } from "../../lib/ui.js";

const CSV_URL = "https://storage.googleapis.com/olo-export-data/export_dimensiot_app000000000000.csv";
const KEY_MEAS = "wms_dimensiot_measurements";
const KEY_SKIP = "wms_dimensiot_skipped";
const NO_LOCATION = ["uusi", "vanha", "null", "muutto", "pu", ""];

let allItems = [];
let activeItems = [];
let measurements = {}; // sku -> {h, l, w} (cm)
const skipSet = new Set();
const drafts = {}; // sku -> {h, l, w} (keskeneräiset syötteet)

const isDone = (sku) => sku in measurements;
const isHandled = (sku) => isDone(sku) || skipSet.has(sku);

function saveState() {
  saveJson(KEY_MEAS, measurements);
  saveJson(KEY_SKIP, [...skipSet]);
}

function loadState() {
  measurements = loadJson(KEY_MEAS, {});
  skipSet.clear();
  loadJson(KEY_SKIP, []).forEach((k) => skipSet.add(k));
}

export function parseDimensionCsv(text) {
  const rows = parseCsvObjects(text);
  if (!rows.length) return [];
  if (!hasColumn(rows[0], "sku") || !hasColumn(rows[0], "storage_location", "hyllypaikka")) return [];

  const items = [];
  for (const r of rows) {
    const hp = pick(r, "storage_location", "hyllypaikka");
    if (NO_LOCATION.includes(hp.toLowerCase()) || hp.length < 5) continue;
    items.push({
      sku: pick(r, "sku"),
      name: pick(r, "name"),
      hyllypaikka: hp,
      height: pick(r, "height"),
      length: pick(r, "length"),
      width: pick(r, "width"),
      tilaus: parseInt(pick(r, "order_count_12_weeks", "Tilausmäärä 12 vko"), 10) || 0,
    });
  }
  return items;
}

// "12,5" ja "12.5" kelpaavat; vain positiiviset luvut.
export function parseDim(value) {
  const n = parseFloat(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function hasRef(it) {
  const h = parseFloat(it.height);
  return it.height && it.height !== "null" && h > 0;
}

function dimInput(sku, axis, label, value) {
  return `<div class="dim-group"><label>${label}</label>
    <input type="text" inputmode="decimal" autocomplete="off" placeholder="0.0"
      data-sku="${esc(sku)}" data-axis="${axis}" value="${esc(value ?? "")}"></div>`;
}

function renderCards() {
  const container = $("cards-container");
  const summary = $("summary-view");
  const total = activeItems.length;
  const handled = activeItems.filter((it) => isHandled(it.sku)).length;

  if (total > 0 && handled === total) {
    container.innerHTML = "";
    show(summary, true);
    $("sum-done").textContent = activeItems.filter((it) => isDone(it.sku)).length;
    $("sum-skip").textContent = activeItems.filter((it) => skipSet.has(it.sku) && !isDone(it.sku)).length;
    return;
  }
  show(summary, false);

  container.innerHTML = activeItems.map((it, i) => {
    const done = isHandled(it.sku);
    const skipped = skipSet.has(it.sku) && !isDone(it.sku);
    const d = drafts[it.sku] || {};
    const sku = esc(it.sku);
    return `<div class="card${done ? " done" : ""}">
      <div class="card-top">
        <span class="card-idx">${i + 1}</span>
        <div style="flex:1"><div class="card-name">${esc(it.name)}</div><div class="card-sku">SKU ${sku}</div></div>
        ${it.tilaus > 0 ? `<span class="badge tilaus">${it.tilaus} kpl/12vko</span>` : ""}
      </div>
      <div class="loc-box"><div class="loc-label">Hyllypaikka</div><div class="loc-code">${esc(it.hyllypaikka)}</div></div>
      ${hasRef(it)
        ? `<div class="ref-dims">Nykyinen: <strong>H ${esc(it.height)} × L ${esc(it.length)} × W ${esc(it.width)} cm</strong></div>`
        : `<div class="ref-dims missing">Ei aiempia dimensioita</div>`}
      ${skipped ? `<div class="btn-row"><button class="btn skip-btn" data-act="unskip" data-sku="${sku}">↩ Peru ohitus</button></div>` : ""}
      ${done ? "" : `<div class="dim-inputs">
        ${dimInput(it.sku, "h", "Korkeus (H)", d.h)}
        ${dimInput(it.sku, "l", "Pituus (L)", d.l)}
        ${dimInput(it.sku, "w", "Leveys (W)", d.w)}
      </div>
      <div class="btn-row">
        <button class="btn skip-btn" data-act="skip" data-sku="${sku}">✕ Ohita</button>
        <button class="btn primary" data-act="save" data-sku="${sku}">✓ Tallenna</button>
      </div>`}
    </div>`;
  }).join("");
}

function updateProgress() {
  const total = activeItems.length;
  const done = activeItems.filter((it) => isHandled(it.sku)).length;
  $("prog").style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
  $("done-count").textContent = `${done} / ${total}`;
}

function refresh() {
  saveState();
  updateProgress();
  renderCards();
}

function reloadItems() {
  const n = parseInt($("count-sel").value, 10) || 20;
  activeItems = [...allItems]
    .sort((a, b) => b.tilaus - a.tilaus)
    .slice(0, n)
    .sort((a, b) => cmpSerpentine(a.hyllypaikka, b.hyllypaikka));
  renderCards();
  updateProgress();
}

function saveDims(sku) {
  const card = $("cards-container");
  const inputs = ["h", "l", "w"].map((axis) => card.querySelector(`input[data-sku="${CSS.escape(sku)}"][data-axis="${axis}"]`));
  const values = inputs.map((el) => parseDim(el?.value));
  inputs.forEach((el, i) => el?.classList.toggle("invalid", values[i] === null));
  if (values.some((v) => v === null)) {
    alert("Syötä kaikki kolme mittaa (H, L, W) positiivisina lukuina, esim. 12,5");
    return;
  }
  measurements[sku] = { h: values[0], l: values[1], w: values[2] };
  skipSet.delete(sku);
  delete drafts[sku];
  refresh();
}

function exportCsv() {
  const entries = Object.entries(measurements);
  if (!entries.length) { alert("Ei mitattuja tuotteita vietäväksi."); return; }
  const fi = (n) => String(n).replace(".", ",");
  const rows = [["sku", "olo_height", "olo_length", "olo_width", "olo_height-unit", "olo_length-unit", "olo_width-unit"]];
  for (const [sku, m] of entries) rows.push([sku, fi(m.h), fi(m.l), fi(m.w), "CENTIMETER", "CENTIMETER", "CENTIMETER"]);
  downloadCsv(`dimensiot_${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

function resetSession() {
  if (!confirm("Aloitetaanko uusi kierros? Kaikki tallennetut mittaukset poistetaan. Lataa CSV ensin, jos et ole vielä viennyt niitä.")) return;
  measurements = {};
  skipSet.clear();
  Object.keys(drafts).forEach((k) => delete drafts[k]);
  removeKeys(KEY_MEAS, KEY_SKIP);
  refresh();
}

async function fetchData() {
  show($("loading-view"), true);
  show($("main-view"), false);
  show($("load-error"), false);
  show($("retry-btn"), false);
  try {
    const items = parseDimensionCsv(await fetchCsvText(CSV_URL));
    if (!items.length) throw new Error("CSV ei tuottanut tarkistettavia tuotteita");
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

$("count-sel").addEventListener("change", reloadItems);
$("export-btn").addEventListener("click", exportCsv);
$("export-btn2").addEventListener("click", exportCsv);
$("reset-btn").addEventListener("click", resetSession);
$("retry-btn").addEventListener("click", fetchData);

$("cards-container").addEventListener("input", (e) => {
  const el = e.target;
  if (!el.dataset.sku) return;
  (drafts[el.dataset.sku] ||= {})[el.dataset.axis] = el.value;
  el.classList.remove("invalid");
});

$("cards-container").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const sku = btn.dataset.sku;
  if (btn.dataset.act === "save") saveDims(sku);
  else if (btn.dataset.act === "skip") { skipSet.add(sku); delete measurements[sku]; refresh(); }
  else if (btn.dataset.act === "unskip") { skipSet.delete(sku); refresh(); }
});

fetchData();
