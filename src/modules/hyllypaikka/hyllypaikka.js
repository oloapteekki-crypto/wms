// Hyllypaikka: farmaseuttien hyllytystoiminto. Skannaa tuotteen viivakoodi (EAN) tai hae nimellä/tuotenumerolla → järjestelmä kertoo hyllypaikan.
// Lähde: tuoterekisteri (GCS hyllytys-app-export: sku, name, ean, storage_location). Ei kirjautumista eikä tietokantaa.
import { fetchCsvText } from "../../lib/csv.js";
import { createCamera, cameraSupported } from "../../lib/camera.js";
import { esc, $ } from "../../lib/ui.js";
import { parseMaster, parseLoc, eanMatches } from "../hyllytys/domain.js";

const GCS_CSV = "https://storage.googleapis.com/olo-export-data/hyllytys-app-export000000000000.csv";

let master = null; // {sku: {name, ean, location}}
let entries = []; // [{sku, name, ean, location, lname}]
let byEan = new Map();
let loadedAt = 0;
let loadError = "";
let camera;

const stripZeros = (s) => String(s || "").trim().replace(/^0+/, "");
const digits = (s) => String(s || "").replace(/\D/g, "");

/* ───────── Tuoterekisteri ───────── */
async function loadMaster() {
  $("status").textContent = "Ladataan tuoterekisteriä…";
  try {
    const text = await fetchCsvText(GCS_CSV);
    if (!text.includes("sku")) throw new Error("CSV ei sisällä oikeita sarakkeita");
    master = parseMaster(text);
    entries = Object.entries(master).map(([sku, m]) => ({ sku, name: m.name, ean: m.ean, location: m.location, lname: (m.name || "").toLowerCase() }));
    byEan = new Map();
    for (const e of entries) {
      const d = digits(e.ean);
      if (!d || e.ean === "null") continue;
      for (const k of new Set([d, stripZeros(d)])) { if (!byEan.has(k)) byEan.set(k, []); byEan.get(k).push(e); }
    }
    loadedAt = Date.now();
    loadError = "";
  } catch (e) {
    loadError = "Tuoterekisteriä ei saatu ladattua: " + e.message;
  }
  renderStatus();
}

function renderStatus() {
  const el = $("status");
  if (loadError) { el.innerHTML = `<div class="err">${esc(loadError)}</div><button id="reload">Yritä uudelleen</button>`; }
  else if (master) { el.innerHTML = `Tuoterekisteri ladattu ${new Date(loadedAt).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" })} · ${entries.length} tuotetta · <button id="reload">Päivitä</button>`; }
  const b = $("reload");
  if (b) b.onclick = loadMaster;
}

/* ───────── Haku ───────── */
// Palauttaa osumat koodille: EAN täsmälleen, EAN ilman etunollia, tuotenumero (VNR), lopuksi EAN-pääte.
function lookup(raw) {
  const code = String(raw || "").trim();
  if (!code || !master) return [];
  const d = digits(code);
  const hit = (d && (byEan.get(d) || byEan.get(stripZeros(d)))) || null;
  if (hit?.length) return hit;
  const bySku = entries.filter((e) => e.sku === code || stripZeros(e.sku) === stripZeros(code));
  if (bySku.length && d.length <= 8) return bySku;
  if (d.length >= 8) {
    const loose = entries.filter((e) => e.ean && e.ean !== "null" && eanMatches(digits(e.ean), d));
    if (loose.length) return loose;
  }
  return bySku;
}

function searchByName(q) {
  const t = q.trim().toLowerCase();
  if (/^\d{3,}$/.test(t)) return entries.filter((e) => e.sku === t || stripZeros(e.sku) === stripZeros(t) || e.sku.startsWith(t)).slice(0, 15);
  if (t.length < 3) return [];
  const words = t.split(/\s+/).filter(Boolean);
  return entries.filter((e) => words.every((w) => e.lname.includes(w))).slice(0, 15);
}

/* ───────── Näkymä ───────── */
function describe(e) {
  const loc = (e.location || "").trim();
  let p = parseLoc(loc);
  // Hyllytys käsittelee esim. UU-hyllyt ≥ 4 "uusina"; farmaseutille näytetään silti rekisterin paikka sellaisenaan
  const m = !p && loc.match(/^([A-Za-z0-9]+)-(\d+)-([A-Za-z0-9]+)-(\d+)$/);
  if (m) p = { aisle: m[1], shelf: m[2], level: m[3], pos: m[4], raw: loc, type: "shelf" };
  if (p?.type === "rx") return { cls: "rx", label: "Reseptilääke · RX-hylly", big: loc, parts: "" };
  if (p?.type === "cold") return { cls: "cold", label: "❄️ Jääkaappi", big: loc, parts: "" };
  if (p) {
    const isShelf = p.type === "shelf";
    return {
      cls: "", label: "Hyllypaikka", big: loc,
      parts: `<span class="badge">${esc(p.aisle)}</span> hylly <b>${esc(p.shelf)}</b>${isShelf ? ` · taso <b>${esc(p.level)}</b> · paikka <b>${esc(p.pos)}</b>` : p.level && p.level !== "0" ? ` · taso <b>${esc(p.level)}</b>` : ""}`,
    };
  }
  const t = loc.toLowerCase();
  if (t === "uusi") return { cls: "warn", label: "Ei vakiopaikkaa", big: "UUSI-hyllyyn", text: true, parts: "Tuotteelle ei ole annettu hyllypaikkaa: vie UUSI-hyllyyn." };
  if (t === "vanha") return { cls: "warn", label: "Ei hyllypaikkaa", big: "Vanha tuote", text: true, parts: "Tuotteella ei ole voimassa olevaa hyllypaikkaa." };
  return { cls: "warn", label: "Ei hyllypaikkaa", big: "Paikka puuttuu", text: true, parts: loc ? "Rekisterissä: " + esc(loc) : "Tuotteelle ei ole annettu hyllypaikkaa." };
}

function showEntries(list, code) {
  const out = $("result");
  if (!list.length) {
    out.innerHTML = `<div class="loc-card miss"><div class="loc-label">Ei löydy</div><div class="loc-big text">${esc(code)}</div></div>`;
    return;
  }
  // Skannauksen jälkeen näytetään vain tuotteen nimi ja varastopaikka
  const main = list[0];
  const d = describe(main);
  out.innerHTML = `<div class="loc-card ${d.cls}"><div class="loc-name">${esc(main.name)}</div>
      <div class="loc-big${d.text ? " text" : ""}">${esc(d.big)}</div></div>`;
  navigator.vibrate?.(60);
}

/* ───────── Skannaus ───────── */
function handleCode(raw) {
  const code = String(raw || "").trim();
  if (!code) return;
  if (!master) { $("result").innerHTML = `<div class="err">${esc(loadError || "Tuoterekisteriä ladataan, yritä hetken kuluttua uudelleen.")}</div>`; return; }
  showEntries(lookup(code), code);
}

function submitScan(f) {
  const v = f.value;
  f.value = "";
  handleCode(v);
  f.focus(); // kenttä pysyy kohdistettuna: seuraava koodi voidaan lukea heti
}

const scanField = $("scan-field");
scanField.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitScan(e.target); } });
// Käsipääte voi kirjoittaa koodin ilman Enteriä: arvo käsitellään, kun se on ≥ 8 merkkiä eikä muutu 250 ms:iin (syöttötapahtumalla ja ajastimella).
let timer = null;
scanField.addEventListener("input", (e) => {
  clearTimeout(timer);
  const f = e.target;
  timer = setTimeout(() => { if (f.value.trim().length >= 8) submitScan(f); }, 250);
});
let polled = "", polledAt = 0;
setInterval(() => {
  const v = scanField.value;
  if (v !== polled) { polled = v; polledAt = Date.now(); return; }
  if (v.trim().length >= 8 && Date.now() - polledAt >= 250) { polled = ""; submitScan(scanField); }
}, 100);

/* ───────── Kamera ───────── */
function stopCamera() {
  camera?.stop();
  $("cam-overlay").style.display = "none";
  $("cam-toggle").classList.remove("on");
}
$("cam-toggle").addEventListener("click", async () => {
  if (camera?.running) { stopCamera(); return; }
  try {
    $("cam-overlay").style.display = "block";
    $("cam-toggle").classList.add("on");
    await camera.start();
  } catch (e) {
    stopCamera();
    $("result").innerHTML = `<div class="err">Kamera-virhe: ${esc(e.message)}</div>`;
  }
});
$("cam-close").addEventListener("click", stopCamera);

/* ───────── Haku nimellä ───────── */
$("search-field").addEventListener("input", (e) => {
  const q = e.target.value;
  const list = master ? searchByName(q) : [];
  $("search-results").innerHTML = list.map((x) => `<div class="hit" data-sku="${esc(x.sku)}"><span class="n">${esc(x.name)}</span><span class="l">${esc(x.location || "–")}</span></div>`).join("")
    || (q.trim().length >= 3 ? `<div class="loc-parts" style="padding:8px">Ei osumia.</div>` : "");
});

document.addEventListener("click", (e) => {
  const hit = e.target.closest(".hit");
  if (!hit) return;
  const found = entries.find((x) => x.sku === hit.dataset.sku);
  if (found) { showEntries([found], found.ean || found.sku); window.scrollTo({ top: 0, behavior: "smooth" }); }
});

/* ───────── Käynnistys ───────── */
camera = createCamera({ video: $("cam-video"), flash: $("cam-flash"), onCode: handleCode });
if (!cameraSupported()) $("cam-toggle").style.display = "none";
loadMaster().then(() => scanField.focus());
