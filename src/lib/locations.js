// Hyllypaikat, käytäväjärjestys ja kokoluokat. Yhteinen kaikille moduuleille.
// Lähde: siirtoappi / dimensioappi (identtinen logiikka kopioituna).

// Keräilylenkin käytäväjärjestys. HUOM: C1–C3, B5 ja B6 löytyvät datasta mutta eivät tästä
// (tunnettu puute, ks. CLAUDE.md) – ne päätyvät indeksiin 99 eli listan loppuun.
export const AISLE_ORDER = [
  "L1", "FA", "L2", "L3", "L4", "L5",
  "A2", "A3", "A4", "A5", "A6", "A1", "A7",
  "B1", "B2", "B3", "B4", "UU", "JK", "RX",
];

export const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "LA"];

export function sizeIdx(s) {
  const i = SIZES.indexOf((s || "").trim().toUpperCase());
  return i === -1 ? 0 : i;
}

export function sizeDiff(current, optimal) {
  return Math.abs(sizeIdx(optimal) - sizeIdx(current));
}

const UNKNOWN = { aisleIdx: 99, row: 99, level: 0, pos: 99 };

// Muoto ALUE-HYLLY-TASO-PAIKKA (esim. A2-12-A-02) tai lavapaikka ALUE-LA-0-NN (esim. L5-LA-0-01).
export function parseLocation(loc) {
  if (!loc) return { ...UNKNOWN };
  const s = loc.trim().toUpperCase();
  const m = s.match(/^([A-Z]+\d*)-(\d+)-([A-Z])-(\d+)$/);
  if (m) {
    const ai = AISLE_ORDER.indexOf(m[1]);
    return {
      aisleIdx: ai === -1 ? 99 : ai,
      row: parseInt(m[2], 10),
      level: m[3].charCodeAt(0),
      pos: parseInt(m[4], 10),
    };
  }
  const pallet = s.match(/^([A-Z]+\d*)-LA-/);
  if (pallet) {
    const ai = AISLE_ORDER.indexOf(pallet[1]);
    return { aisleIdx: ai === -1 ? 99 : ai, row: 999, level: 999, pos: 999 };
  }
  return { ...UNKNOWN };
}

// Käärmekulku: parittomilla käytäväindekseillä rivijärjestys käännetään.
export function serpentineKey(loc) {
  const p = parseLocation(loc);
  const rowKey = p.aisleIdx % 2 === 1 ? 1000 - p.row : p.row;
  return [p.aisleIdx, rowKey, p.level, p.pos];
}

export function cmpSerpentine(a, b) {
  const ka = serpentineKey(a);
  const kb = serpentineKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}
