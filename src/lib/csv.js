// CSV-parseri (RFC 4180): tukee lainausmerkkejä, pilkkuja ja rivinvaihtoja kenttien sisällä.
// Korvaa vanhojen appien regex-pohjaisen parserin.

export function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] || "").trim() !== "");
}

// Palauttaa taulukon olioita otsikkorivin mukaan.
export function parseCsvObjects(text, delimiter = ",") {
  const rows = parseCsv(text, delimiter);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
}

// Hakee ensimmäisen olemassa olevan sarakkeen arvon (kirjainkoosta riippumatta). Tukee vanhoja sarakenimiä.
export function pick(obj, ...names) {
  const keys = Object.keys(obj);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined) return obj[k];
  }
  return "";
}

export function hasColumn(obj, ...names) {
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  return names.some((n) => keys.includes(n.toLowerCase()));
}

// Muodostaa CSV-tekstin (oletuksena `;` ja \n) ja käynnistää latauksen selaimessa.
export function downloadCsv(filename, rows, delimiter = ";") {
  const cell = (v) => {
    const s = String(v ?? "");
    return s.includes(delimiter) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = rows.map((r) => r.map(cell).join(delimiter)).join("\n");
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function fetchCsvText(url) {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.text();
}
