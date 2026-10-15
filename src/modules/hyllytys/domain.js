// Hyllytyksen toimintalogiikka (ei DOM-riippuvuuksia lukuun ottamatta parseXml).
// Portattu hyllytysappiuusi/index.html:stä. Appi on totuus: kärryjako ja reitti säilytetty ennallaan.
import { parseCsvObjects, pick } from "../../lib/csv.js";

/* ───────── Kärryt ───────── */
export const CARTS = [
  { id: "L", name: "L-kärry", color: "#ef4444", icon: "🔴", aisles: ["L1", "FA", "L2", "L3"], shelves: ["L1", "L2", "L3", "FA"] },
  { id: "A", name: "A-kärry", color: "#10b981", icon: "🟢", aisles: ["A2", "A3", "A4", "A5", "A6_even", "A6odd_A1even", "A1odd_A7"], shelves: ["A1+A6", "A2", "A3", "A4", "A5"] },
  { id: "B", name: "B-kärry", color: "#3b82f6", icon: "🔵", aisles: ["B1", "B2", "B3", "B4", "UU"], shelves: ["B1", "B2", "B3", "B4", "UU"] },
];

export function cartOfAisle(physAisle) {
  const c = CARTS.find((x) => x.aisles.includes(physAisle));
  return c ? c.id : null;
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
  return {
    vnr, altVnr,
    name: item.name || m.name || "?",
    ean: m.ean || "",
    qty: item.qty,
    location: parsedLoc ? locStr : null,
    parsedLoc, physAisle,
    cartId: physAisle ? cartOfAisle(physAisle) : null,
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
