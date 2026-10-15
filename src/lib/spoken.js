// Suomenkielisen puheen jäsennys: kokonaisluvut (0–9999) ja päiväykset. Puhtaita funktioita (testattavissa).
// Puheentunnistus palauttaa usein numerot jo numeroina ("16.12.2026"), mutta myös sanoina ("kaksikymmentäkuusi").

const ONES = { nolla: 0, yksi: 1, kaksi: 2, kolme: 3, neljä: 4, viisi: 5, kuusi: 6, seitsemän: 7, kahdeksan: 8, yhdeksän: 9 };
const ONES_RE = "yksi|kaksi|kolme|neljä|viisi|kuusi|seitsemän|kahdeksan|yhdeksän";

// Yhdyssana tai yhdistetty: "kaksikymmentäkuusi", "satakaksikymmentä", "kaksituhattakaksikymmentäkuusi" → luku tai null.
function parseCompound(word) {
  let rest = word;
  let total = 0;
  let m;
  if ((m = rest.match(new RegExp(`^(${ONES_RE})?(tuhatta|tuhat)`)))) { total += (m[1] ? ONES[m[1]] : 1) * 1000; rest = rest.slice(m[0].length); }
  if ((m = rest.match(new RegExp(`^(${ONES_RE})?(sataa|sata)`)))) { total += (m[1] ? ONES[m[1]] : 1) * 100; rest = rest.slice(m[0].length); }
  if ((m = rest.match(new RegExp(`^(${ONES_RE})kymmentä`)))) { total += ONES[m[1]] * 10; rest = rest.slice(m[0].length); }
  else if ((m = rest.match(/^kymmenen/))) { total += 10; rest = rest.slice(m[0].length); }
  else if ((m = rest.match(new RegExp(`^(${ONES_RE})toista`)))) { total += 10 + ONES[m[1]]; rest = rest.slice(m[0].length); }
  if (rest !== "") {
    if (rest in ONES && !(rest === "nolla" && total > 0)) { total += ONES[rest]; rest = ""; }
    else return null;
  }
  return total === 0 && word !== "nolla" ? null : total;
}

// Kokonaisluku puheesta: "36", "kolmekymmentäkuusi", "sata kaksikymmentä", "kaksi tuhatta kaksikymmentäkuusi" → luku tai null.
export function parseFinnishInt(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const joined = t.replace(/[,.]/g, "").replace(/\s+/g, "");
  if (/^\d+$/.test(joined)) return parseInt(joined, 10);
  return parseCompound(joined);
}

/* ───────── Järjestysluvut päivälle ("viides huhtikuuta") ───────── */
const ORD_UNITS = { ensimmäinen: 1, toinen: 2, kolmas: 3, neljäs: 4, viides: 5, kuudes: 6, seitsemäs: 7, kahdeksas: 8, yhdeksäs: 9 };
const ORD_TEENS = { kymmenes: 10, yhdestoista: 11, kahdestoista: 12, kolmastoista: 13, neljästoista: 14, viidestoista: 15, kuudestoista: 16, seitsemästoista: 17, kahdeksastoista: 18, yhdeksästoista: 19 };
// 1–31: "viides", "kolmastoista", "kahdeskymmenesviides", "kolmaskymmenesensimmäinen" → luku tai null
export function parseOrdinalDay(w) {
  const s = String(w ?? "").trim().toLowerCase();
  if (s in ORD_UNITS) return ORD_UNITS[s];
  if (s in ORD_TEENS) return ORD_TEENS[s];
  if (s === "kahdeskymmenes") return 20;
  if (s === "kolmaskymmenes") return 30;
  let m;
  if ((m = s.match(/^kahdeskymmenes(.+)$/)) && m[1] in ORD_UNITS) return 20 + ORD_UNITS[m[1]];
  if ((m = s.match(/^kolmaskymmenes(.+)$/)) && m[1] === "ensimmäinen") return 31;
  return null;
}

/* ───────── Päiväys ───────── */
const MONTH_PREFIX = ["tammi", "helmi", "maalis", "huhti", "touko", "kesä", "heinä", "elo", "syys", "loka", "marras", "joulu"];
const monthFromWord = (w) => {
  const m = w.match(/^(tammi|helmi|maalis|huhti|touko|kesä|heinä|elo|syys|loka|marras|joulu)kuu(ta|n|ssa)?$/);
  return m ? MONTH_PREFIX.indexOf(m[1]) + 1 : null;
};

const pad = (n) => String(n).padStart(2, "0");
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const normYear = (y) => (y < 100 ? 2000 + y : y);

function build(y, m, d) {
  y = normYear(y);
  if (!(m >= 1 && m <= 12) || y < 2000 || y > 2100) return null;
  const monthOnly = d === null;
  if (!monthOnly && !(d >= 1 && d <= daysIn(y, m))) return null;
  const day = monthOnly ? daysIn(y, m) : d; // pelkkä kk/vv = kuukauden viimeinen päivä (8/26 → 20260831)
  return { ymd: `${y}${pad(m)}${pad(day)}`, monthOnly, label: `${day}.${m}.${y}${monthOnly ? " (kk:n loppu)" : ""}` };
}

// Puhutut erottimet ("kuusi kautta kaksikymmentäseitsemän" = 6/27) ja yksitellen sanotut numerot
// ("nolla kuusi" = 06, "kaksi seitsemän" = 27, "nolla kuusi kaksi seitsemän" = 0627 = 6/27).
const SEP_WORDS = new Set(["kautta", "kauttaviiva", "kenoviiva", "viiva", "per", "slash", "piste", "pistettä"]);
const isDigitToken = (w) => w in ONES || /^\d$/.test(w);
function normalizeSpoken(t) {
  const tokens = t.split(/\s+/).filter(Boolean).map((w) => (SEP_WORDS.has(w) ? "/" : w));
  const groups = [[]];
  for (const w of tokens) { if (w === "/") groups.push([]); else groups[groups.length - 1].push(w); }
  return groups.map((g) => (g.length >= 2 && g.every(isDigitToken) ? g.map((w) => (w in ONES ? ONES[w] : w)).join("") : g.join(" "))).join("/");
}

// Puheesta tai kirjoituksesta päiväykseksi. Palauttaa {ymd:'YYYYMMDD', monthOnly, label} tai null.
export function parseSpokenDate(text) {
  let t = String(text ?? "").trim().toLowerCase();
  if (!t) return null;
  t = normalizeSpoken(t);
  t = t.replace(/\s*(\.|\/|-|:)\s*/g, "$1");

  // Numeromuodot
  let m;
  if ((m = t.match(/^(\d{4})(\d{2})(\d{2})$/)) && Number(m[1]) >= 2000) return build(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = t.match(/^(\d{1,2})[.\-/: ](\d{1,2})[.\-/: ](\d{2}|\d{4})$/))) return build(Number(m[3]), Number(m[2]), Number(m[1]));
  if ((m = t.match(/^(\d{1,2})[.\-/: ](\d{2}|\d{4})$/))) return build(Number(m[2]), Number(m[1]), null);
  if ((m = t.match(/^(\d{2})(\d{2})(\d{2}|\d{4})$/))) return build(Number(m[3]), Number(m[2]), Number(m[1]));
  if ((m = t.match(/^(\d{2})(\d{2})$/))) return build(Number(m[2]), Number(m[1]), null);

  // Sanamuodot: yhdistä "kaksi tuhatta" → "kaksituhatta", jaa sanoiksi
  const split = t.replace(/\s+(tuhatta|tuhat|sataa|sata)(?=\s|$)/g, "$1").split(/[\s.\-/:]+/).filter(Boolean);
  // "kaksituhatta kaksikymmentäkuusi" on yksi luku (vuosi)
  const words = [];
  for (let i = 0; i < split.length; i++) {
    let w = split[i];
    if (/(tuhatta|tuhat)$/.test(w) && i + 1 < split.length) { w += split[i + 1]; i++; }
    words.push(w);
  }
  const monthIdx = words.findIndex((w) => monthFromWord(w));
  if (monthIdx !== -1) {
    const mo = monthFromWord(words[monthIdx]);
    const before = words.slice(0, monthIdx).join("");
    const after = words.slice(monthIdx + 1).join("");
    const d = before ? (parseOrdinalDay(before) ?? parseFinnishInt(before)) : null;
    if (before && d === null) return null;
    let y = after ? parseFinnishInt(after) : null;
    if (after && y === null) return null;
    if (y === null) { // vuotta ei sanottu: lähin tuleva ajankohta (vanhenemispäivä on aina tulevaisuudessa)
      const now = new Date();
      y = now.getFullYear();
      const cand = build(y, mo, d);
      if (cand && cand.ymd < `${y}${pad(now.getMonth() + 1)}${pad(now.getDate())}`) y += 1;
    }
    return build(y, mo, d);
  }
  const nums = words.map((w) => parseFinnishInt(w));
  if (nums.some((n) => n === null)) return null;
  if (nums.length === 3) return build(nums[2], nums[1], nums[0]);
  if (nums.length === 2) return build(nums[1], nums[0], null);
  return null;
}

// "20260831" → "31.8.2026"
export function formatYmd(ymd) {
  if (!/^\d{8}$/.test(ymd || "")) return "";
  return `${Number(ymd.slice(6))}.${Number(ymd.slice(4, 6))}.${ymd.slice(0, 4)}`;
}
