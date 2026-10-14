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
  const rows = lines.map((l, i) => {
    const rec = recs[l.key] || {};
    const delivered = rec.qty || 0;
    const end = delivered > 0 ? rec.end || "" : "";
    return `  <InvoiceRow>
    <ArticleIdentifier>${esc(l.sku)}</ArticleIdentifier>
    <ArticleGroupIdentifier></ArticleGroupIdentifier>
    <ArticleName>${esc(l.name)}</ArticleName>
    <BuyerArticleIdentifier>${esc(l.sku)}</BuyerArticleIdentifier>
    <DeliveredQuantity QuantityUnitCode="Kpl">${delivered}</DeliveredQuantity>
    <OrderedQuantity QuantityUnitCode="Kpl">${l.ordered}</OrderedQuantity>
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
    <RowAmount AmountCurrencyIdentifier="EUR">${money(l.price * l.ordered)}</RowAmount>
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

/* ───────── Kärryjako hyllytysreitin mukaan ───────── */
// recs: saapuneet. master: tuoterekisteri (parseMaster). Palauttaa ryhmät ja tuotteet reittijärjestyksessä.
export function splitToCarts(lines, recs, master) {
  const items = [];
  for (const l of lines) {
    const qty = recs[l.key]?.qty || 0;
    if (qty <= 0) continue;
    const e = enrichItem({ vnr: l.sku, altVnr: "", name: l.name, qty }, master || {});
    items.push({ ...e, ean: e.ean || l.ean });
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
