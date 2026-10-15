// Toimittajatilauksen vastaanotto: tilauksen luku taulukosta, tilanteet, XML (Finvoice DEV01) ja kärryjako.
// Korvaa Tilaukset-Sheetin "vastaanotto"-välilehden ja "Tee XML vastaanottoa varten" -skriptin.
// XML-muoto vastaa taulukon xml-data-välilehden tuottamaa tiedostoa (esim. 261010_New Organics.xml).
import { colNum } from "../../lib/xlsx.js";
import { enrichItem, sortRoute, CARTS } from "../hyllytys/domain.js";

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
// Taulukon numerot voivat olla tieteellisessä muodossa (8.18625026097E11) → kokonaisluku merkkijonona
const idStr = (v) => (typeof v === "number" ? String(Math.round(v)) : str(v));

export const lineKey = (sku) => String(sku).replace(/[.#$/[\]]/g, "_");
export const orderId = (supplier, date) => `${date}_${supplier.replace(/[^\p{L}\p{N}]+/gu, "_")}`;

/* ───────── Tilauksen luku (xlsx) ───────── */
// Tilaus-välilehti: C1 toimittaja, C2 tilauspäivä (YYYYMMDD), rivit alkaen riviltä 6:
// A ean, B sku, C nimi, N tilausmäärä, O alennus-%, P alennettu hinta, E ostohinta.
// Toimittajat-välilehti: B nimi, C yrityksen nimi, D Y-tunnus.
export async function parseOrderWorkbook(xlsx, fileName = "") {
  const order = await xlsx.sheet("Tilaus");
  const supplierId = str(order.get("C1"));
  if (!supplierId) throw new Error("Tilaus-välilehdeltä puuttuu toimittaja (solu C1)");
  const orderDate = idStr(order.get("C2"));
  if (!/^\d{8}$/.test(orderDate)) throw new Error("Tilauspäivä (solu C2) ei ole muotoa VVVVKKPP");

  let supplier = { id: supplierId, name: supplierId, taxCode: "" };
  if (xlsx.sheetNames.includes("Toimittajat")) {
    const sup = await xlsx.sheet("Toimittajat");
    for (let r = 2; r < 500; r++) {
      if (str(sup.get("B" + r)) === supplierId) {
        supplier = { id: supplierId, name: str(sup.get("C" + r)) || supplierId, taxCode: str(sup.get("D" + r)) };
        break;
      }
    }
  }

  const rows = new Set();
  for (const ref of Object.keys(order.cells)) {
    const r = Number(ref.match(/\d+/)[0]);
    if (r >= 6) rows.add(r);
  }
  const lines = [];
  for (const r of [...rows].sort((a, b) => a - b)) {
    const sku = idStr(order.get("B" + r));
    const ordered = Number(order.get("N" + r)) || 0;
    if (!sku || ordered <= 0) continue; // vain tilatut rivit
    const price = order.get("P" + r);
    const base = Number(order.get("E" + r)) || 0;
    const discount = Number(order.get("O" + r)) || 0;
    lines.push({
      sku, ean: idStr(order.get("A" + r)), name: str(order.get("C" + r)), ordered,
      price: typeof price === "number" ? price : Math.round((1 - discount) * base * 100) / 100,
    });
  }
  if (!lines.length) throw new Error("Tilauksessa ei ole rivejä, joilla tilausmäärä > 0 (sarake N)");
  // Sama tuote voi olla tilauksessa usealla rivillä → jokaiselle rivinumero-pohjainen uniikki avain (ei yhdistetä rivejä)
  const seen = {};
  for (const l of lines) {
    const k = lineKey(l.sku);
    seen[k] = (seen[k] || 0) + 1;
    l.key = seen[k] === 1 ? k : `${k}_${seen[k]}`;
  }
  return { id: orderId(supplier.id, orderDate), supplier, orderDate, fileName, lines };
}

/* ───────── Vastaanotto: laatikkoerät ───────── */
// Sama tuote voi tulla usessa laatikossa. Tallennus: rec/{rivi} = {none?: true, b: {erä-id: {qty, end?, t, by}}}.
// buildRec muodostaa tästä rivin yhteenvedon: {qty, end, batches[]}; qty on erien summa, end on null jos jollakin erällä puuttuu päiväys.
export function buildRec(raw) {
  if (!raw) return null;
  const batches = Object.entries(raw.b || {})
    .map(([id, b]) => ({ id, qty: Number(b.qty) || 0, end: b.end === undefined ? null : b.end, t: b.t || 0, by: b.by || "" }))
    .sort((a, b) => a.t - b.t);
  if (!batches.length) return raw.none ? { qty: 0, end: "", batches: [], none: true } : null;
  const qty = batches.reduce((s, b) => s + b.qty, 0);
  return { qty, end: batches.some((b) => b.end === null) ? null : batches[batches.length - 1].end, batches };
}

// Erät XML:ää varten: yhdistää saman päiväyksen erät. Ilman batches-kenttää (vanha muoto) käytetään qty/end.
export function dateGroups(rec) {
  const src = rec?.batches ?? (rec?.qty > 0 ? [{ qty: rec.qty, end: rec.end }] : []);
  const groups = [];
  for (const b of src) {
    if (!(b.qty > 0)) continue;
    const end = b.end || "";
    const g = groups.find((x) => x.end === end);
    if (g) g.qty += b.qty; else groups.push({ end, qty: b.qty });
  }
  return groups;
}

/* ───────── Vastaanotto: rivin tila ───────── */
// rec: {qty: number|null, end: null (ei asetettu) | "" (ei päiväystä) | "YYYYMMDD"}
export function lineStatus(line, rec) {
  if (!rec || rec.qty === null || rec.qty === undefined) return "pending";
  if (rec.qty > 0 && (rec.end === null || rec.end === undefined)) return "needsDate";
  if (rec.qty === 0) return "none";
  if (rec.qty < line.ordered) return "under";
  if (rec.qty > line.ordered) return "over";
  return "ok";
}

export function summarize(lines, recs) {
  const s = { total: lines.length, pending: 0, needsDate: 0, ok: 0, under: 0, over: 0, none: 0, receivedUnits: 0, orderedUnits: 0 };
  for (const l of lines) {
    const st = lineStatus(l, recs[l.key]);
    s[st]++;
    s.orderedUnits += l.ordered;
    s.receivedUnits += recs[l.key]?.qty || 0;
  }
  s.done = s.total - s.pending - s.needsDate;
  return s;
}

/* ───────── XML ───────── */
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",");

// Rivit joilla on tilausmäärä > 0 (myös ei-saapuneet, jolloin DeliveredQuantity 0). RowAmount = tilattu × hinta (kuten taulukossa).
export function buildXml({ supplier, lines, recs }) {
  // Yksi rivi per eri päiväys; tilattu määrä ja rivisumma ensimmäiselle riville, jatkoriveille 0
  const rowDefs = [];
  for (const l of lines) {
    const groups = dateGroups(recs[l.key]);
    if (!groups.length) rowDefs.push({ l, delivered: 0, end: "", first: true });
    else groups.forEach((g, gi) => rowDefs.push({ l, delivered: g.qty, end: g.end, first: gi === 0 }));
  }
  const rows = rowDefs.map(({ l, delivered, end, first }, i) => {
    const ordered = first ? l.ordered : 0;
    return `  <InvoiceRow>
    <ArticleIdentifier>${esc(l.sku)}</ArticleIdentifier>
    <ArticleGroupIdentifier></ArticleGroupIdentifier>
    <ArticleName>${esc(l.name)}</ArticleName>
    <BuyerArticleIdentifier>${esc(l.sku)}</BuyerArticleIdentifier>
    <DeliveredQuantity QuantityUnitCode="Kpl">${delivered}</DeliveredQuantity>
    <OrderedQuantity QuantityUnitCode="Kpl">${ordered}</OrderedQuantity>
    <EndDate>${esc(end)}</EndDate>
    <OriginalInvoiceNumber></OriginalInvoiceNumber>
    <UnitPriceAmount AmountCurrencyIdentifier="EUR" UnitPriceUnitCode="e/kpl">${money(l.price)}</UnitPriceAmount>
    <RowIdentifier>${i + 1}</RowIdentifier>
    <RowFreeText></RowFreeText>
    <OrderIdentifier></OrderIdentifier>
    <RowDeliveryDetails>
      <RowManufacturerIdentifier></RowManufacturerIdentifier>
      <RowAgreementIdentifier></RowAgreementIdentifier>
    </RowDeliveryDetails>
    <RowAmount AmountCurrencyIdentifier="EUR">${money(l.price * ordered)}</RowAmount>
  </InvoiceRow>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Finvoice version="1.2">
  <SellerPartyDetails>
    <SellerPartyIdentifier>${esc(supplier.id)}</SellerPartyIdentifier>
    <SellerOrganisationName>${esc(supplier.name)}</SellerOrganisationName>
    <SellerOrganisationTaxCode>${esc(supplier.taxCode)}</SellerOrganisationTaxCode>
    <SellerPostalAddressDetails>
      <SellerStreetName></SellerStreetName>
      <SellerTownName></SellerTownName>
      <SellerPostCodeIdentifier></SellerPostCodeIdentifier>
      <CountryCode></CountryCode>
      <CountryName></CountryName>
    </SellerPostalAddressDetails>
  </SellerPartyDetails>
  <BuyerPartyDetails>
    <BuyerPartyIdentifier></BuyerPartyIdentifier>
    <BuyerOrganisationName></BuyerOrganisationName>
    <BuyerPostalAddressDetails>
      <BuyerStreetName></BuyerStreetName>
      <BuyerTownName></BuyerTownName>
      <BuyerPostCodeIdentifier></BuyerPostCodeIdentifier>
      <CountryCode></CountryCode>
      <CountryName></CountryName>
    </BuyerPostalAddressDetails>
  </BuyerPartyDetails>
  <InvoiceDetails>
    <InvoiceTypeCode>DEV01</InvoiceTypeCode>
    <InvoiceTypeText>TOIMITUSILMOITUS</InvoiceTypeText>
    <OriginCode>Origin</OriginCode>
    <InvoiceNumber>1</InvoiceNumber>
    <InvoiceDate Format="CCYYMMDD"></InvoiceDate>
  </InvoiceDetails>
${rows}
</Finvoice>`;
}

// Tiedostonimi kuten 261010_New Organics.xml (VVKKPP_toimittaja)
export function xmlFileName(supplier, orderDate) {
  return `${orderDate.slice(2)}_${supplier.name.replace(/[\\/:*?"<>|]/g, "_")}.xml`;
}

/* ───────── Mihin tuote laitetaan (kärry / levy / paikka) ───────── */
// Palauttaa {kind, icon, label, color, location, aisle} tai null jos hyllypaikkoja ei ole ladattu.
export function placement(line, master) {
  if (!master) return null;
  const e = enrichItem({ vnr: line.sku, altVnr: "", name: line.name, qty: line.ordered }, master);
  if (e.parsedLoc?.type === "rx") return { kind: "rx", icon: "💊", label: "Reseptilääke", color: "#b91c1c", location: e.location, aisle: null };
  if (e.parsedLoc?.type === "cold") return { kind: "cold", icon: "❄️", label: "Jääkaappi", color: "#0369a1", location: e.location, aisle: null };
  if (!e.parsedLoc) return { kind: "new", icon: "📦", label: "UUSI-hyllyyn", color: "#f59e0b", location: null, aisle: null };
  const cart = CARTS.find((c) => c.id === e.cartId);
  if (cart) return { kind: "cart", icon: cart.icon, label: cart.name, color: cart.color, location: e.location, aisle: e.physAisle, cartId: cart.id };
  return { kind: "other", icon: "🏗", label: "Lavapaikka / muu paikka", color: "#64748b", location: e.location, aisle: e.physAisle };
}

/* ───────── Kärryjako hyllytysreitin mukaan ───────── */
// recs: saapuneet. master: tuoterekisteri (parseMaster). Palauttaa ryhmät ja tuotteet reittijärjestyksessä.
export function splitToCarts(lines, recs, master) {
  const items = [];
  for (const l of lines) {
    const qty = recs[l.key]?.qty || 0;
    if (qty <= 0) continue;
    const e = enrichItem({ vnr: l.sku, altVnr: "", name: l.name, qty }, master || {});
    items.push({ ...e, ean: e.ean || l.ean, exp: dateGroups(recs[l.key]) });
  }
  const groups = CARTS.map((c) => ({ ...c, kind: "cart", items: sortRoute(items.filter((i) => i.cartId === c.id)) }));
  groups.push({ id: "RX", name: "Reseptilääkkeet", icon: "💊", color: "#b91c1c", kind: "rx", items: items.filter((i) => i.parsedLoc?.type === "rx") });
  groups.push({ id: "UUSI", name: "UUSI-hyllyyn", icon: "📦", color: "#f59e0b", kind: "new", items: items.filter((i) => !i.parsedLoc) });
  groups.push({
    id: "MUU", name: "Muut paikat (lavapaikat, jääkaappi)", icon: "🏗", color: "#64748b", kind: "other",
    items: items.filter((i) => i.parsedLoc && !i.cartId && i.parsedLoc.type !== "rx"),
  });
  return { groups: groups.filter((g) => g.items.length), items };
}

export { colNum };
