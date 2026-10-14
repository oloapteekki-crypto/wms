// Inventoinnin datan haku ja tallennus. Dataa haetaan VAIN kun käyttäjä käynnistää haun inventointiosiossa
// (ei taustahakuja, ajastettua päivitystä eikä latausta muissa osioissa).
import { fetchCsvText } from "../../lib/csv.js";
import { decodeFileText } from "./files.js";
import { parseExport, parseMaxx, parseMagento, parseEanRegister, buildFromLegacy, productsToSnapshot, productsFromSnapshot } from "./domain.js";

// BigQueryn ajastettu vienti (ks. CLAUDE.md): sku, name, ean, storage_location, maxx_qty, qty_unshipped, exported_at
export const EXPORT_URL = "https://storage.googleapis.com/olo-export-data/export_inventointi_app000000000000.csv";
const EAN_URL = "https://storage.googleapis.com/olo-export-data/hyllytys-app-export000000000000.csv";

export async function fetchExport() {
  const text = await fetchCsvText(EXPORT_URL);
  if (!text.includes("qty_unshipped")) throw new Error("Vientitiedosto ei sisällä odotettuja sarakkeita");
  const { products, exportedAt } = parseExport(text);
  if (!products.length) throw new Error("Vientitiedostossa ei ole tuotteita");
  return { products, exportedAt, source: "vienti" };
}

async function fetchEanMap(store) {
  try {
    const text = await fetchCsvText(EAN_URL);
    if (text.includes("sku")) { const m = parseEanRegister(text); if (Object.keys(m).length) return m; }
  } catch { /* varahaku alla */ }
  try {
    const csv = await store.get("files/csv");
    if (csv) return parseEanRegister(csv);
  } catch { /* ei EAN-koodeja */ }
  return {};
}

// Varakeino: käsin ladatut tiedostot (Maxx-saldo + keräilemätön + valinnainen EAN-rekisteri).
export async function loadFromFiles(store, { maxxFile, magFile, eanFile }) {
  const maxx = parseMaxx(await decodeFileText(maxxFile, "iso-8859-15"));
  const magento = parseMagento(await decodeFileText(magFile, "utf-8"));
  const eanMap = eanFile ? parseEanRegister(await decodeFileText(eanFile, "utf-8")) : await fetchEanMap(store);
  const products = buildFromLegacy(maxx, magento, eanMap);
  if (!products.length) throw new Error("Tiedostoista ei löytynyt tuotteita hyllypaikoilla");
  return { products, exportedAt: "", source: "tiedostot", noEan: !Object.keys(eanMap).length };
}

// Tallentaa odotetut saldot Firebaseen (muut laitteet ja PC-näkymä käyttävät samaa). keepCounted=false aloittaa puhtaalta pöydältä.
export async function saveSnapshot(store, { products, exportedAt, source }, { keepCounted = true, by = "" } = {}) {
  if (!keepCounted) {
    await store.remove("inventointi/counted");
    await store.remove("inventointi/dismissed");
  }
  await store.set("inventointi/products", productsToSnapshot(products));
  await store.set("inventointi/meta", { loadedAt: Date.now(), source, exportedAt: exportedAt || "", by, count: products.length });
}

export async function readSnapshot(store) {
  const [data, meta] = await Promise.all([store.get("inventointi/products"), store.get("inventointi/meta")]);
  return { products: productsFromSnapshot(data), meta: meta || null };
}
