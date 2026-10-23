// Hyllytyksen toimintalogiikka (ei DOM-riippuvuuksia lukuun ottamatta parseXml).
// Portattu hyllytysappiuusi/index.html:stä. Appi on totuus: kärryjako ja reitti säilytetty ennallaan.
import { parseCsvObjects, pick } from "../../lib/csv.js";

/* ───────── Kärryt ───────── */
// L-alueella 1 kärry, A- ja B-alueilla 2 kärryä, jotka voivat olla hyllytyksessä yhtä aikaa. Jako seuraa reittiä (ks. ROUTE), jolloin
// kärryn 1 reitti päättyy siihen, mihin kärryn 2 alkaa, ja hyllylevyt tyhjenevät serpentiinissä järjestyksessä.
// Rajat on laskettu tuoterekisterin paikkamääristä (n. 3 370 tuotetta A-alueella, n. 2 300 + 2 300 B-alueella):
//   A-kärry 1: A2, A3 ja A4 hyllyt 15–26 · A-kärry 2: A4 hyllyt 1–14, A5, A6/A1 ja A7
//   B-kärry 1: B1, B2 ja B3 hyllyt 0–16 · B-kärry 2: B3 hyllyt 17–26, B4 ja UU
// Rajan siirto: muuta SPLITS-riviä (alin hyllynumero, joka kuuluu reitin loppupään kärrylle).
export const CARTS = [
  { id: "L", name: "L-kärry", color: "#ef4444", icon: "🔴", aisles: ["L1", "FA", "L2", "L3"], desc: "L1, FA, L2, L3" },
  { id: "A1", name: "A-kärry 1", color: "#10b981", icon: "🟢", aisles: ["A2", "A3", "A4"], desc: "A2, A3, A4 (hyllyt 15–26)" },
  { id: "A2", name: "A-kärry 2", color: "#0d9488", icon: "🟩", aisles: ["A4", "A5", "A6_even", "A6odd_A1even", "A1odd_A7"], desc: "A4 (hyllyt 1–14), A5, A6/A1, A7" },
  { id: "B1", name: "B-kärry 1", color: "#3b82f6", icon: "🔵", aisles: ["B1", "B2", "B3"], desc: "B1, B2, B3 (hyllyt 0–16)" },
  { id: "B2", name: "B-kärry 2", color: "#6366f1", icon: "🟣", aisles: ["B3", "B4", "UU"], desc: "B3 (hyllyt 17–26), B4, UU" },
];

// Jaettu käytävä: shelf >= from → reitin loppupään kärry (late), muuten alkupään (early).
const SPLITS = { A4: { from: 15, early: "A2", late: "A1" }, B3: { from: 17, early: "B1", late: "B2" } };
const CART_BY_AISLE = {
  L1: "L", FA: "L", L2: "L", L3: "L",
  A2: "A1", A3: "A1", A5: "A2", A6_even: "A2", A6odd_A1even: "A2", A1odd_A7: "A2",
  B1: "B1", B2: "B1", B4: "B2", UU: "B2",
};

// Levyt: jokaisessa kärryssä 5 levyä, jotka seuraavat reittiä (levy 1 ensin). Levyn alkukohta on (fyysinen käytävä, hyllynumero);
// levy 1 alkaa kärryn reitin alusta. Rajat laskettu tuoterekisterin paikkamääristä (≈ 250 / 340 / 460 tuotetta per levy L / A / B).
// from = [käytävä, hylly], label = levyn sisältö. Rajan siirto: muuta from-arvoa ja label-tekstiä.
export const PLATES = {
  // FA-paikoille tulee vain pieniä määriä, joten koko FA (766 tuotetta) mahtuu yhdelle levylle.
  L: [
    { label: "L1" },
    { from: ["FA", 1], label: "FA (kaikki hyllyt)" },
    { from: ["L2", 10], label: "L2 hyllyt 10–6" },
    { from: ["L2", 5], label: "L2 hyllyt 5–1" },
    { from: ["L3", 0], label: "L3" },
  ],
  A1: [
    { label: "A2 hyllyt 26–16" },
    { from: ["A2", 15], label: "A2 hyllyt 15–3" },
    { from: ["A2", 2], label: "A2 hyllyt 2–1, A3 hyllyt 0–15" },
    { from: ["A3", 16], label: "A3 hyllyt 16–26" },
    { from: ["A4", 26], label: "A4 hyllyt 26–15" },
  ],
  A2: [
    { label: "A4 hyllyt 14–1, A5 hylly 0" },
    { from: ["A5", 1], label: "A5 hyllyt 1–19" },
    { from: ["A5", 20], label: "A5 hyllyt 20–26, A6/A1 hyllyt 0–8" },
    { from: ["A6odd_A1even", 9], label: "A6/A1 hyllyt 9–25" },
    { from: ["A6odd_A1even", 26], label: "A6/A1 hylly 26, A1/A7" },
  ],
  B1: [
    { label: "B1 hyllyt 0–11" },
    { from: ["B1", 12], label: "B1 hyllyt 12–26, B2 hyllyt 26–22" },
    { from: ["B2", 21], label: "B2 hyllyt 21–11" },
    { from: ["B2", 10], label: "B2 hyllyt 10–0, B3 hyllyt 0–4" },
    { from: ["B3", 5], label: "B3 hyllyt 5–16" },
  ],
  B2: [
    { label: "B3 hyllyt 17–26, B4 hyllyt 26–25" },
    { from: ["B4", 24], label: "B4 hyllyt 24–12" },
    { from: ["B4", 11], label: "B4 hyllyt 11–0" },
    { from: ["UU", 1], label: "UU hylly 1" },
    { from: ["UU", 3], label: "UU hylly 3" },
  ],
};

// Paikan järjestysluku reitillä (nouseva/laskeva hyllyjärjestys käytävän suunnan mukaan).
const routePos = (physAisle, shelf) => routeIndex(physAisle) * 1000 + (ROUTE_ASC[physAisle] === 0 ? 999 - shelf : shelf);

// Levyn numero 1–5 kärryn sisällä (null, jos kärrylle ei ole levyjä).
export function plateOf(cartId, parsedLoc, physAisle) {
  const plates = PLATES[cartId];
  if (!plates || !parsedLoc || !physAisle) return null;
  const pos = routePos(physAisle, parseInt(parsedLoc.shelf, 10) || 0);
  let plate = 1;
  plates.forEach((p, i) => { if (p.from && pos >= routePos(p.from[0], p.from[1])) plate = i + 1; });
  return plate;
}

// Kärry paikalle (parsedLoc + fyysinen käytävä). Reitin ulkopuoliset (RX, JK, L4/L5, uusi) → null.
export function cartOfLoc(parsedLoc, physAisle) {
  const sp = SPLITS[physAisle];
  if (sp) return (parseInt(parsedLoc?.shelf, 10) || 0) >= sp.from ? sp.late : sp.early;
  return CART_BY_AISLE[physAisle] || null;
}

/* ───────── Reitti (asc: 1 = hyllynumerot nousevasti, 0 = laskevasti) ───────── */
const ROUTE = [
  { id: "L1", asc: 1 }, { id: "FA", asc: 1 }, { id: "L2", asc: 0 }, { id: "L3", asc: 1 }, { id: "L4", asc: 0 }, { id: "L5", asc: 1 },
  { id: "A2", asc: 0 }, { id: "A3", asc: 1 }, { id: "A4", asc: 0 }, { id: "A5", asc: 1 },
  { id: "A6_even", asc: 0 }, { id: "A6odd_A1even", asc: 1 }, { id: "A1odd_A7", asc: 0 },
  { id: "B1", asc: 1 }, { id: "B2", asc: 0 }, { id: "B3", asc: 1 }, { id: "B4", asc: 0 },
  { id: "UU", asc: 1 }, { id: "RX", asc: 1 }, { id: "JK", asc: 1 },
];
const ROUTE_ORDER = ROUTE.map((r) => r.id);
const ROUTE_ASC = Object.fromEntries(ROUTE.map((r) => [r.id, r.asc]));

export function routeIndex(physAisle) {
  const i = ROUTE_ORDER.indexOf(physAisle);
  return i === -1 ? 999 : i;
}

export function sortRoute(items) {
  return [...items].sort((a, b) => {
    if (!a.parsedLoc && !b.parsedLoc) return 0;
    if (!a.parsedLoc) return 1;
    if (!b.parsedLoc) return -1;
    const pa = routeIndex(a.physAisle);
    const pb = routeIndex(b.physAisle);
    if (pa !== pb) return pa - pb;
    const asc = ROUTE_ASC[a.physAisle] !== 0;
    const sc = a.parsedLoc.shelf.localeCompare(b.parsedLoc.shelf, undefined, { numeric: true });
    if (sc) return asc ? sc : -sc;
    const lc = a.parsedLoc.level.localeCompare(b.parsedLoc.level);
    if (lc) return asc ? lc : -lc;
    const pc = a.parsedLoc.pos.localeCompare(b.parsedLoc.pos, undefined, { numeric: true });
    return asc ? pc : -pc;
  });
}

/* ───────── Hyllypaikka ───────── */
// Palauttaa null jos paikkaa ei ole (uusi/vanha/null/0) tai UU-hylly ≥ 4 (käsitellään "uusi"-paikkana).
export function parseLoc(l) {
  if (!l || typeof l !== "string") return null;
  const t = l.trim();
  if (!t || ["uusi", "null", "vanha", "0"].includes(t.toLowerCase())) return null;
  const p = t.split("-");
  if (p.length === 4) {
    if (p[0].toUpperCase() === "UU" && parseInt(p[1], 10) >= 4) return null;
    return { aisle: p[0], shelf: p[1], level: p[2], pos: p[3], raw: t, type: "shelf" };
  }
  if (/^[A-Za-z]\d{1,2}$/.test(t)) return { aisle: "RX", shelf: t, level: "0", pos: "0", raw: t, type: "rx" };
  if (p.length === 3) return { aisle: p[0], shelf: p[1], level: p[2], pos: "0", raw: t, type: "shelf3" };
  if (/^JK\d+$/i.test(t)) return { aisle: "JK", shelf: t, level: "0", pos: "0", raw: t, type: "cold" };
  return null;
}

function isOdd(s) {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n % 2 !== 0;
}

// Fyysinen käytävä (A6/A1/A7 jaetaan hyllynumeron parillisuuden mukaan).
export function physicalAisle(p) {
  if (p.type === "rx") return "RX";
  if (p.type === "cold") return "JK";
  const { aisle: a, shelf: s } = p;
  const odd = isOdd(s);
  if (a === "A6") return odd ? "A6odd_A1even" : "A6_even";
  if (a === "A1") return odd === false ? "A6odd_A1even" : "A1odd_A7";
  if (a === "A7") return "A1odd_A7";
  return a;
}

/* ───────── Laskettavat tuotteet (suuri hävikki) ───────── */
// Tukkutilauksissa lasketaan vain tuotteet, joilla on suuri inventointitappio (MAXX: Inventointitapahtumat-raportti).
// Muut hyllytetään ilman määrän laskentaa (määrä oletetaan XML:n mukaiseksi). Jos listaa ei ole ladattu, lasketaan kaikki.
export const SHRINK_THRESHOLD_EUR = 100;
export const normSku = (s) => String(s ?? "").trim().replace(/^0+/, "");

export function isCounted(item, shrink) {
  if (!shrink) return true;
  return !!(shrink[normSku(item.vnr)] || (item.altVnr && shrink[normSku(item.altVnr)]));
}

// MAXX-raportti (CSV, ; erotin, Windows-1252): rivit "Tuotenimi;;;;Tuotenro;Aika;Määrä;;Inv.ero;;Summa;;Tosite;;Käsitt.".
// Tappio = tuotteen negatiivisten inventointitapahtumien summa (€). Palauttaa {skus: {tuotenro: tappio €}, ...}.
export function parseShrinkCsv(buffer, thresholdEur = SHRINK_THRESHOLD_EUR) {
  const text = new TextDecoder("windows-1252").decode(buffer);
  const loss = {};
  let events = 0;
  let period = "";
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(";");
    if (!period && /^\d+\.\d+\.\d{4}\s*-\s*\d+\.\d+\.\d{4}$/.test((f[3] || "").trim())) period = f[3].trim();
    if (f.length < 11 || !/^\d+$/.test((f[4] || "").trim()) || !/^\d+\.\d+\.\d{4}$/.test((f[5] || "").trim())) continue;
    const sum = parseFloat((f[10] || "").replace(/[\s ]/g, "").replace(",", "."));
    if (Number.isNaN(sum)) continue;
    events++;
    if (sum < 0) { const k = normSku(f[4]); loss[k] = (loss[k] || 0) + -sum; }
  }
  const skus = {};
  for (const [k, v] of Object.entries(loss)) if (v >= thresholdEur) skus[k] = Math.round(v);
  return { skus, count: Object.keys(skus).length, events, products: Object.keys(loss).length, threshold: thresholdEur, period };
}

/* ───────── Parserit ───────── */
// Tuoterekisteri: { sku: {name, ean, location} }
export function parseMaster(text) {
  const map = {};
  for (const r of parseCsvObjects(text)) {
    const sku = pick(r, "sku").trim();
    if (!sku) continue;
    const loc = Object.keys(r).find((k) => k.toLowerCase().includes("location"));
    map[sku] = { name: pick(r, "name").trim(), ean: pick(r, "ean").trim(), location: loc ? r[loc].trim() : "" };
  }
  return map;
}

// XML:n merkistö luetaan prologista (Finvoice on yleensä ISO-8859-15) – korjaa ä/ö-vioittumisen.
export function decodeXmlBuffer(buffer) {
  const head = new TextDecoder("ascii").decode(new Uint8Array(buffer).slice(0, 200));
  const m = head.match(/encoding=["']([^"']+)["']/i);
  let enc = (m ? m[1] : "utf-8").toLowerCase();
  try {
    return new TextDecoder(enc).decode(buffer);
  } catch {
    enc = "iso-8859-15";
    return new TextDecoder(enc).decode(buffer);
  }
}

// Toimitusilmoitus (Finvoice) → { boxes: {boxId: [{vnr, altVnr, name, qty}]}, altKeys: {avain: boxId} }
export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const txt = (el, sel) => el.querySelector(sel)?.textContent || "";
  const invoice = txt(doc, "InvoiceNumber") || Math.random().toString(36).slice(2, 8);
  const boxes = {};
  const altKeys = {};

  doc.querySelectorAll("InvoiceRow").forEach((row) => {
    const group = txt(row, "ArticleGroupIdentifier");
    const pkg = txt(row, "PackageNumber");
    const list = txt(row, "BoxlistNumber");
    let boxId;
    if (group && group !== "?") boxId = group;
    else if (pkg) boxId = pkg;
    else if (list) boxId = list;
    else boxId = "inv_" + invoice;

    const orig = txt(row, "OriginalInvoiceNumber");
    const pick_ = txt(row, "PicklistNumber");
    if (orig) altKeys[orig] = boxId;
    if (pick_) altKeys[pick_] = boxId;

    const vnr = txt(row, "ArticleIdentifier");
    const altVnr = txt(row, "VnrIdentifier");
    if (!vnr && !altVnr) return;
    const qty = parseInt(txt(row, "DeliveredQuantity").replace(",", ".") || "0", 10) || 0;
    (boxes[boxId] ||= []);
    const existing = boxes[boxId].find((i) => i.vnr === vnr);
    if (existing) existing.qty += qty;
    else boxes[boxId].push({ vnr, altVnr, name: txt(row, "ArticleName"), qty });
  });
  altKeys[invoice] = "inv_" + invoice;
  return { boxes, altKeys };
}

// Yhdistää useiden XML-tiedostojen laatikot.
export function mergeParsed(parsedList) {
  const boxes = {};
  const altKeys = {};
  for (const p of parsedList) {
    Object.assign(altKeys, p.altKeys);
    for (const [k, items] of Object.entries(p.boxes)) {
      (boxes[k] ||= []);
      for (const item of items) {
        const e = boxes[k].find((x) => x.vnr === item.vnr);
        if (e) e.qty += item.qty;
        else boxes[k].push({ ...item });
      }
    }
  }
  return { boxes, altKeys };
}

/* ───────── Rikastus ───────── */
const stripZeros = (s) => s.replace(/^0+/, "");

export function lookupMaster(master, vnr, alt) {
  return master[vnr] || master[stripZeros(vnr)] || (alt ? master[alt] || master[stripZeros(alt)] : null) || {};
}

// Eräkohtaiset parasta ennen -päiväykset (Vastaanotosta): [{end:"YYYYMMDD", qty}] päiväysjärjestyksessä, päiväyksettömät viimeisenä.
export function mergeExp(a, b) {
  const g = {};
  for (const x of [...(a || []), ...(b || [])]) { const k = x.end || ""; g[k] = (g[k] || 0) + (Number(x.qty) || 0); }
  return Object.entries(g).map(([end, qty]) => ({ end, qty })).sort((p, q) => (p.end === "") - (q.end === "") || p.end.localeCompare(q.end));
}

export function enrichItem(item, master) {
  const vnr = String(item.vnr || "");
  const altVnr = String(item.altVnr || "");
  const m = lookupMaster(master, vnr, altVnr);
  const locStr = (m.location || "").trim();
  const parsedLoc = parseLoc(locStr);
  const physAisle = parsedLoc ? physicalAisle(parsedLoc) : null;
  const cartId = physAisle ? cartOfLoc(parsedLoc, physAisle) : null;
  return {
    vnr, altVnr,
    name: item.name || m.name || "?",
    ean: m.ean || "",
    qty: item.qty,
    location: parsedLoc ? locStr : null,
    parsedLoc, physAisle,
    cartId, plate: cartId ? plateOf(cartId, parsedLoc, physAisle) : null,
    exp: item.exp ? mergeExp(Object.values(item.exp), []) : null,
  };
}

export function eanMatches(itemEan, code) {
  return !!itemEan && itemEan !== "null" && (itemEan === code || code.endsWith(itemEan) || itemEan.endsWith(code));
}

/* ───────── Laatikot ja erät ───────── */
export const boxKey = (sscc) => sscc.replace(/[.#$/[\]]/g, "_");

// Etsii laatikon koodilla: täsmä, pääte, vaihtoehtoinen avain tai (≥18 numeroa) ainoa lukematon.
export function findBox(code, xmlBoxes, altKeys, isScanned) {
  let sscc = xmlBoxes[code] ? code : Object.keys(xmlBoxes).find((k) => k.endsWith(code) || code.endsWith(k));
  if (!sscc && altKeys) {
    const m = altKeys[code];
    if (m && xmlBoxes[m]) sscc = m;
  }
  if (!sscc && code.length >= 18 && /^\d+$/.test(code)) {
    const unscanned = Object.keys(xmlBoxes).filter((k) => !isScanned(k));
    if (unscanned.length === 1) sscc = unscanned[0];
  }
  return sscc || null;
}

// Erälista kärrylle: [{id, since, until, num}]. Viimeinen ("current") on täyttyvä erä.
export function batchList(cartBatches, cartId) {
  const batches = cartBatches?.[cartId];
  if (!batches) return [{ id: "current", since: 0, until: Infinity, num: 1 }];
  const sorted = Object.entries(batches).map(([id, v]) => ({ id, t: v.t })).sort((a, b) => a.t - b.t);
  const list = [];
  let prev = 0;
  sorted.forEach((s, i) => { list.push({ id: s.id, since: prev, until: s.t, num: i + 1 }); prev = s.t; });
  list.push({ id: "current", since: prev, until: Infinity, num: sorted.length + 1 });
  return list;
}

// Erän tuotteet kärrylle (yhdistetty, rikastettu).
export function batchItems(scannedBoxes, batch, cartId, master) {
  const all = [];
  for (const b of Object.values(scannedBoxes || {})) {
    if (!b.items || b.t <= batch.since || (batch.until !== Infinity && b.t > batch.until)) continue;
    for (const item of b.items) {
      const e = enrichItem(item, master);
      if (e.cartId !== cartId) continue;
      const ex = all.find((i) => i.vnr === e.vnr);
      if (ex) { ex.qty += e.qty; if (e.exp || ex.exp) ex.exp = mergeExp(ex.exp, e.exp); }
      else all.push(e);
    }
  }
  return all;
}

export function batchRemaining(scannedBoxes, shelvedByBatch, batch, cartId, master) {
  const done = shelvedByBatch?.[`${cartId}_${batch.id}`] || {};
  return batchItems(scannedBoxes, batch, cartId, master).filter((i) => i.qty - (done[i.vnr] || 0) > 0).length;
}

// Kaikki skannatut tuotteet yhdistettynä (purkunäkymän laskurit).
export function allScannedEnriched(scannedBoxes, master) {
  const all = [];
  for (const b of Object.values(scannedBoxes || {})) {
    for (const item of b.items || []) {
      const e = enrichItem(item, master);
      const ex = all.find((i) => i.vnr === e.vnr);
      if (ex) { ex.qty += e.qty; if (e.exp || ex.exp) ex.exp = mergeExp(ex.exp, e.exp); }
      else all.push(e);
    }
  }
  return all;
}

export function totals(routeItems, shelved) {
  return {
    shelved: routeItems.reduce((s, i) => s + Math.min(shelved[i.vnr] || 0, i.qty), 0),
    expected: routeItems.reduce((s, i) => s + i.qty, 0),
  };
}

// Raportti: ryhmittely.
export function buildReport(routeItems, shelved) {
  const r = { ok: [], under: [], over: [], notDone: [] };
  for (const i of routeItems) {
    const s = shelved[i.vnr] || 0;
    const row = { ...i, sq: s };
    if (s === i.qty) r.ok.push(row);
    else if (s > i.qty) r.over.push(row);
    else if (s > 0) r.under.push(row);
    else r.notDone.push(row);
  }
  return r;
}
