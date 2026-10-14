// Minimaalinen xlsx-lukija (vain luku): zip-purku selaimen DecompressionStreamilla + sheet-XML:n jäsennys.
// Riittää taulukon arvojen (ei kaavojen) lukemiseen. Ei ulkoisia kirjastoja.

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Palauttaa {tiedostonimi: async () => Uint8Array}
function readZipIndex(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("Ei kelvollinen xlsx-tiedosto");
  const count = u16(view, eocd + 10);
  let p = u32(view, eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (u32(view, p) !== 0x02014b50) throw new Error("Zip-hakemisto virheellinen");
    const method = u16(view, p + 10);
    const compSize = u32(view, p + 20);
    const nameLen = u16(view, p + 28), extraLen = u16(view, p + 30), commentLen = u16(view, p + 32);
    const localOffset = u32(view, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    files[name] = async () => {
      const lnLen = u16(view, localOffset + 26), leLen = u16(view, localOffset + 28);
      const start = localOffset + 30 + lnLen + leLen;
      const data = bytes.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error("Tuntematon pakkaustapa " + method);
    };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decodeText = async (files, name) => (files[name] ? new TextDecoder("utf-8").decode(await files[name]()) : null);
const parseXml = (text) => new DOMParser().parseFromString(text, "application/xml");

// Lukee xlsx-tiedoston. Palauttaa {sheetNames, sheet(name) → {get(ref), cells}} (arvot: merkkijono tai luku).
export async function readXlsx(fileOrBuffer) {
  const buf = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const files = readZipIndex(buf);

  const shared = [];
  const ssText = await decodeText(files, "xl/sharedStrings.xml");
  if (ssText) {
    for (const si of parseXml(ssText).getElementsByTagName("si")) {
      shared.push([...si.getElementsByTagName("t")].map((t) => t.textContent).join(""));
    }
  }

  const wb = parseXml(await decodeText(files, "xl/workbook.xml"));
  const rels = parseXml(await decodeText(files, "xl/_rels/workbook.xml.rels"));
  const relTarget = {};
  for (const r of rels.getElementsByTagName("Relationship")) relTarget[r.getAttribute("Id")] = r.getAttribute("Target");
  const sheetFiles = {};
  const sheetNames = [];
  for (const s of wb.getElementsByTagName("sheet")) {
    const rid = s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = relTarget[rid] || "";
    sheetFiles[s.getAttribute("name")] = target.startsWith("/") ? target.slice(1) : "xl/" + target;
    sheetNames.push(s.getAttribute("name"));
  }

  const cache = {};
  return {
    sheetNames,
    async sheet(name) {
      if (cache[name]) return cache[name];
      const path = sheetFiles[name];
      if (!path || !files[path]) throw new Error(`Taulukkoa "${name}" ei löydy tiedostosta`);
      const doc = parseXml(await decodeText(files, path));
      const cells = {};
      for (const c of doc.getElementsByTagName("c")) {
        const ref = c.getAttribute("r");
        const t = c.getAttribute("t");
        const vEl = c.getElementsByTagName("v")[0];
        let val;
        if (t === "inlineStr") val = [...c.getElementsByTagName("t")].map((x) => x.textContent).join("");
        else if (!vEl) continue;
        else if (t === "s") val = shared[Number(vEl.textContent)] ?? "";
        else if (t === "str" || t === "e") val = vEl.textContent;
        else if (t === "b") val = vEl.textContent === "1";
        else { const n = Number(vEl.textContent); val = Number.isNaN(n) ? vEl.textContent : n; }
        cells[ref] = val;
      }
      return (cache[name] = { cells, get: (ref) => cells[ref] });
    },
  };
}

// Sarakekirjain → sarakenumero (A=1)
export const colNum = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
