// Inventoinnin toimintalogiikka. Portattu hyllytysappiuusi/inventointi.html:stä.
// Odotettu määrä = MAXX-saldo + keräämätön (tilaukset status=processing, ei vielä picked, ilman B2B:tä).
import { parseCsvObjects, pick } from "../../lib/csv.js";

/* ───────── Reitti (inventoinnissa A6/A1/A7 omina käytävinään; asc: 1 = hyllynumerot nousevasti) ───────── */
const ROUTE = [
  { id: "L1", asc: 1 }, { id: "FA", asc: 1 }, { id: "L2", asc: 0 }, { id: "L3", asc: 1 }, { id: "L4", asc: 0 }, { id: "L5", asc: 1 },
  { id: "A2", asc: 0 }, { id: "A3", asc: 1 }, { id: "A4", asc: 0 }, { id: "A5", asc: 1 }, { id: "A6", asc: 0 }, { id: "A1", asc: 1 }, { id: "A7", asc: 0 },
  { id: "B1", asc: 1 }, { id: "B2", asc: 0 }, { id: "B3", asc: 1 }, { id: "B4", asc: 0 }, { id: "UU", asc: 1 },
];
const ROUTE_IDS = ROUTE.map((r) => r.id);

export const aisleIdx = (a) => {
  const i = ROUTE_IDS.indexOf(a);
  return i === -1 ? 999 : i;
};
const aisleAsc = (a) => (ROUTE.find((r) => r.id === a)?.asc ?? 1);

// Hyllypaikka ALUE-HYLLY-TASO-PAIKKA (tai 3-osainen). Muut (uusi, RX, JK…) eivät kuulu inventointiin.
export function parseLoc(l) {
  if (!l || typeof l !== "string") return null;
  const t = l.trim();
  if (!t) return null;
  const p = t.split("-");
  if (p.length === 4) return { aisle: p[0], shelf: p[1], level: p[2], pos: p[3], raw: t, shelfKey: p[0] + "-" + p[1] };
  if (p.length === 3) return { aisle: p[0], shelf: p[1], level: p[2], pos: "0", raw: t, shelfKey: p[0] + "-" + p[1] };
  return null;
}

export function sortByRoute(items) {
  return [...items].sort((a, b) => {
    if (!a.loc && !b.loc) return 0;
    if (!a.loc) return 1;
    if (!b.loc) return -1;
    const ai = aisleIdx(a.loc.aisle), bi = aisleIdx(b.loc.aisle);
    if (ai !== bi) return ai - bi;
    const asc = aisleAsc(a.loc.aisle);
    const s = a.loc.shelf.localeCompare(b.loc.shelf, undefined, { numeric: true });
    if (s) return asc ? s : -s;
    const l = a.loc.level.localeCompare(b.loc.level);
    if (l) return asc ? l : -l;
    const p = a.loc.pos.localeCompare(b.loc.pos, undefined, { numeric: true });
    return asc ? p : -p;
  });
}

export function groupShelves(products) {
  const shelves = {};
  for (const p of products) {
    (shelves[p.shelfKey] ||= { key: p.shelfKey, aisle: p.loc.aisle, shelf: p.loc.shelf, count: 0 }).count++;
  }
  return Object.values(shelves).sort((a, b) => {
    const ai = aisleIdx(a.aisle), bi = aisleIdx(b.aisle);
    return ai !== bi ? ai - bi : a.shelf.localeCompare(b.shelf, undefined, { numeric: true });
  });
}

/* ───────── Tuotteiden muodostus ───────── */
const toNum = (v) => parseFloat(String(v ?? "0").replace(",", ".")) || 0;

export function makeProduct({ vnr, name, ean, location, saldo, unshipped }) {
  const loc = parseLoc(location);
  if (!loc) return null;
  return {
    vnr, name: name || "", ean: ean && ean !== "null" ? ean : "", location, loc,
    saldo, unshipped, expected: Math.round(saldo + unshipped), shelfKey: loc.shelfKey,
  };
}

// Uusi vientitiedosto: sku, name, ean, storage_location, maxx_qty, qty_unshipped, exported_at
export function parseExport(text) {
  const rows = parseCsvObjects(text);
  const products = [];
  let exportedAt = "";
  for (const r of rows) {
    const vnr = pick(r, "sku");
    if (!vnr) continue;
    exportedAt ||= pick(r, "exported_at");
    const p = makeProduct({
      vnr, name: pick(r, "name"), ean: pick(r, "ean"), location: pick(r, "storage_location"),
      saldo: toNum(pick(r, "maxx_qty")), unshipped: toNum(pick(r, "qty_unshipped")),
    });
    if (p) products.push(p);
  }
  return { products, exportedAt };
}

/* ───────── Vanhat käsin ladattavat tiedostot (varakeino) ───────── */
// InventointialustaXRP: puolipiste, ISO-8859-15, 3 otsikkoriviä; sarakkeet 0=nimi, 3=VNR, 4=paikka, 9=saldo
export function parseMaxx(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const data = {};
  for (let i = 3; i < lines.length; i++) {
    const cols = lines[i].split(";");
    if (cols.length < 10) continue;
    const vnr = cols[3].trim();
    if (!vnr) continue;
    data[vnr] = { name: cols[0].trim(), vnr, location: cols[4].trim(), saldo: toNum(cols[9]) };
  }
  return data;
}

export function parseMagento(text) {
  const data = {};
  for (const r of parseCsvObjects(text)) {
    const sku = pick(r, "sku").replace(/"/g, "");
    if (sku) data[sku] = { unshipped: toNum(pick(r, "qty_unshipped")) };
  }
  return data;
}

export function parseEanRegister(text) {
  const map = {};
  for (const r of parseCsvObjects(text)) {
    const sku = pick(r, "sku");
    const ean = pick(r, "ean");
    if (sku && ean && ean !== "null") map[sku] = ean;
  }
  return map;
}

export function buildFromLegacy(maxx, magento, eanMap) {
  const products = [];
  for (const vnr of Object.keys(maxx)) {
    const m = maxx[vnr];
    const p = makeProduct({
      vnr, name: m.name, ean: eanMap[vnr] || "", location: m.location, saldo: m.saldo,
      unshipped: (magento[vnr] || { unshipped: 0 }).unshipped,
    });
    if (p) products.push(p);
  }
  return products;
}

/* ───────── Firebase-snapshot ───────── */
export function productsToSnapshot(products) {
  const data = {};
  for (const p of products) data[p.vnr] = { name: p.name, ean: p.ean || "", location: p.location, expected: p.expected, saldo: p.saldo, unshipped: p.unshipped };
  return data;
}

export function productsFromSnapshot(data) {
  const products = [];
  for (const vnr of Object.keys(data || {})) {
    const d = data[vnr];
    const loc = parseLoc(d.location || "");
    if (!loc) continue;
    products.push({
      vnr, name: d.name || "", ean: d.ean || "", location: d.location, loc,
      expected: d.expected || 0, saldo: d.saldo || 0, unshipped: d.unshipped || 0, shelfKey: loc.shelfKey,
    });
  }
  return products;
}

/* ───────── Raportit ───────── */
const klo = (t) => (t ? new Date(t).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }) : "");

// counted: {vnr: {qty, name, location, worker, t, date}}, products: [{vnr, ...}]
export function rowsAll(products, counted) {
  const rows = [["VNR", "Nimi", "EAN", "Paikka", "Maxx Saldo", "Keräilemätön", "Odotettu", "Inventoitu", "Erotus", "Inventoija", "Päivä", "Klo"]];
  const items = [];
  for (const p of products) {
    const c = counted[p.vnr];
    if (c) items.push({ p, c });
  }
  items.sort((a, b) => (a.c.t || 0) - (b.c.t || 0));
  for (const { p, c } of items) rows.push([p.vnr, p.name, p.ean, p.location, p.saldo, p.unshipped, p.expected, c.qty, c.qty - p.expected, c.worker || "", c.date || "", klo(c.t)]);
  return rows;
}

export function rowsDeviations(products, counted, { onlyDate = null, dismissed = {} } = {}) {
  const rows = [["VNR", "Nimi", "EAN", "Paikka", "Odotettu", "Inventoitu", "Erotus", "Inventoija", "Päivä", "Klo"]];
  const items = [];
  for (const p of products) {
    const c = counted[p.vnr];
    if (!c || c.qty === p.expected || dismissed[p.vnr]) continue;
    if (onlyDate && c.date !== onlyDate) continue;
    items.push({ p, c });
  }
  items.sort((a, b) => (a.c.t || 0) - (b.c.t || 0));
  for (const { p, c } of items) rows.push([p.vnr, p.name, p.ean, p.location, p.expected, c.qty, c.qty - p.expected, c.worker || "", c.date || "", klo(c.t)]);
  return rows;
}

export function rowsToday(products, counted, today) {
  const rows = [["VNR", "Nimi", "EAN", "Paikka", "Odotettu", "Inventoitu", "Erotus", "Inventoija", "Klo"]];
  const byVnr = Object.fromEntries(products.map((p) => [p.vnr, p]));
  const items = Object.entries(counted).filter(([, c]) => c.date === today).sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
  for (const [vnr, c] of items) {
    const p = byVnr[vnr] || {};
    rows.push([vnr, c.name || p.name || "", p.ean || "", c.location || p.location || "", p.expected || 0, c.qty, c.qty - (p.expected || 0), c.worker || "", klo(c.t)]);
  }
  return rows;
}

export { klo };
