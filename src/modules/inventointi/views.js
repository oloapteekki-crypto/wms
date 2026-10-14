// Inventoinnin näkymät (laskenta). Puhtaita funktioita; kaikki data esc():n kautta.
import { esc } from "../../lib/ui.js";

const result = (r) => (r ? `<div class="scan-result ${r.type === "ok" ? "scan-ok" : "scan-fail"}">${esc(r.text)}</div>` : "");
const err = (e) => (e ? `<div class="error">${esc(e)}</div>` : "");
const metaText = (m) => {
  if (!m) return "";
  const parts = [];
  if (m.loadedAt) parts.push("Haettu " + new Date(m.loadedAt).toLocaleString("fi-FI"));
  if (m.exportedAt) parts.push("vienti " + new Date(m.exportedAt).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }));
  if (m.source) parts.push(m.source);
  if (m.count) parts.push(m.count + " tuotetta");
  return parts.join(" • ");
};

/* ───────── Aloitus ───────── */
export function setupView(v) {
  const { S, workers, currentWorker, storeKind } = v;
  const busy = !!S.loading;
  return `
    <a class="back" href="../../../index.html">← WMS</a>
    ${storeKind === "local" ? `<div class="mode-banner">⚠ Paikallinen tila: laskennat eivät jakaudu laitteiden välillä.</div>` : ""}
    <div class="card"><h1>📋 Inventointi</h1><p class="sub">Olo-apteekki</p>
      <div class="mb-12"><label class="label">Käyttäjä</label>
        <select class="select" data-change="worker"><option value="">— Valitse —</option>
          ${workers.map((w) => `<option value="${esc(w)}"${w === currentWorker ? " selected" : ""}>${esc(w)}</option>`).join("")}</select></div>
      <div class="mb-12"><label class="label">Laite</label>
        <div class="flex gap-8">
          <button class="device-btn${S.device === "phone" ? " on" : ""}" data-action="device" data-device="phone">📱 Puhelin</button>
          <button class="device-btn${S.device === "scanner" ? " on" : ""}" data-action="device" data-device="scanner">🔫 Käsipääte</button>
        </div></div>
      ${v.snapshotMeta ? `<div class="meta">Tallennettu data: ${esc(metaText(v.snapshotMeta))}</div>` : ""}
      <button class="btn" data-action="load-export" ${busy ? "disabled" : ""}>${esc(S.loading || "🔄 Hae tuore data (BigQuery-vienti)")}</button>
      <p class="hint">Hakee MAXX-saldon ja keräämättömät. Päivittää odotetut määrät, laskennat säilyvät.</p>
      <div class="sep">tai</div>
      <button class="btn" style="background:#7c3aed" data-action="load-snapshot" ${busy ? "disabled" : ""}>📱 Käytä tallennettua dataa</button>
      <p class="hint">Jos data on jo haettu (esim. tietokoneella)</p>
      <details style="margin-top:12px"><summary style="font-size:13px;color:#7c3aed;cursor:pointer">📁 Lataa tiedostoista (varakeino)</summary>
        <div style="margin-top:8px">
          <div class="mb-8"><label class="label">Maxx saldo (InventointialustaXRP)</label><input type="file" id="maxx-file" accept=".csv" style="font-size:14px;width:100%"></div>
          <div class="mb-8"><label class="label">Keräilemätön (Magento inventory)</label><input type="file" id="mag-file" accept=".csv" style="font-size:14px;width:100%"></div>
          <div class="mb-12"><label class="label">Tuoterekisteri / EAN (valinnainen)</label><input type="file" id="ean-file" accept=".csv" style="font-size:14px;width:100%"></div>
          <button class="btn" data-action="load-files" ${busy ? "disabled" : ""}>Lataa tiedostoista</button>
        </div></details>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:12px"><input type="checkbox" id="keep-counted" checked> Säilytä aiemmat inventointitulokset</label>
      ${err(S.error)}${result(S.result)}</div>`;
}

/* ───────── Hyllyn valinta ───────── */
export function shelfSelectView(v) {
  const { S, today } = v;
  const totalCounted = S.products.filter((p) => S.allCounted[p.vnr] !== undefined).length;
  const devs = S.products.filter((p) => S.allCounted[p.vnr] !== undefined && S.allCounted[p.vnr] !== p.expected).length;
  return `
    <div class="card"><h1>📋 Valitse hylly</h1>
      <p class="sub">Inventoitu: ${totalCounted}/${S.products.length}${devs ? " — ⚠ " + devs + " eroa" : ""}</p>
      ${result(S.result)}
      <div class="flex gap-8 mb-12">
        <button class="btn-sm btn-outline flex-1" data-action="show-devs">⚠ Erot (${devs})</button>
        <button class="btn-sm btn-outline flex-1" data-action="dl-all">📥 Kaikki</button>
        <button class="btn-sm btn-outline flex-1" data-action="dl-today" data-today="${today}">📥 Tänään</button>
      </div></div>
    <details class="card"><summary style="font-size:14px;font-weight:600;color:#7c3aed;cursor:pointer">🔍 Tarkistettavat (CSV-lista)</summary>
      <div style="margin-top:8px"><p style="font-size:12px;color:#64748b;margin-bottom:8px">Lataa CSV jossa VNR per rivi. Tuotteet näkyvät omana "hyllynä".</p>
        <input type="file" id="checklist-file" accept=".csv,.txt" style="font-size:13px;width:100%;margin-bottom:8px">
        <button class="btn-sm btn-outline" style="width:100%" data-action="load-checklist">Lataa tarkistuslista</button></div></details>
    ${S.checkListItems ? `<div class="shelf-btn" style="margin-bottom:12px;border-color:#7c3aed;background:#ede9fe" data-action="select-shelf" data-key="__CHECK__">
      <div style="font-size:16px;font-weight:700">🔍 Tarkistettavat</div>
      <div style="font-size:11px;color:#7c3aed">${S.checkListItems.filter((i) => S.allCounted[i.vnr] !== undefined).length}/${S.checkListItems.length}</div></div>` : ""}
    <div class="shelf-grid">
      ${S.shelves.map((sh) => {
        const counted = S.shelfStats[sh.key]?.counted || 0;
        const total = S.shelfStats[sh.key]?.total || 0;
        const done = total > 0 && counted === total;
        return `<div class="shelf-btn${done ? " done" : ""}" data-action="select-shelf" data-key="${esc(sh.key)}"><div style="font-size:16px;font-weight:700">${esc(sh.key)}</div><div style="font-size:11px;color:#64748b">${counted}/${total}</div></div>`;
      }).join("")}
    </div>
    <button class="btn-sm btn-outline" style="width:100%;margin-top:12px" data-action="back-setup">← Takaisin</button>`;
}

/* ───────── Erot ───────── */
export function deviationsView(v) {
  const { S, currentWorker } = v;
  const devs = S.products
    .filter((p) => S.allCounted[p.vnr] !== undefined && S.allCounted[p.vnr] !== p.expected)
    .map((p) => ({ ...p, counted: S.allCounted[p.vnr], diff: S.allCounted[p.vnr] - p.expected }))
    .sort((a, b) => a.diff - b.diff);
  return `
    <div class="card"><h1>⚠ Inventointierot</h1><p class="sub">${devs.length} tuotetta${currentWorker ? " — 👤 " + esc(currentWorker) : ""}</p>
      <div class="flex gap-8 mb-12">
        <button class="btn-sm btn-outline flex-1" data-action="dl-devs">📥 Erot CSV</button>
        <button class="btn-sm btn-outline flex-1" data-action="show-shelves">← Hyllyt</button></div></div>
    ${devs.length ? devs.map((d) => `<div class="deviation ${d.diff > 0 ? "dev-plus" : "dev-minus"}">
        <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:12px">${esc(d.name)}</div><div class="mono" style="color:#64748b">${esc(d.location)} | VNR ${esc(d.vnr)}</div></div>
        <div style="text-align:right;white-space:nowrap;margin-left:8px"><div style="font-weight:700">${d.counted} / ${d.expected}</div><div style="font-size:12px;font-weight:700">${d.diff > 0 ? "+" : ""}${d.diff}</div></div></div>`).join("")
      : `<div class="card" style="text-align:center;padding:24px"><div style="font-size:36px;margin-bottom:8px">✓</div><h2 style="color:#16a34a">Ei eroja</h2></div>`}`;
}

/* ───────── Laskenta ───────── */
export function countingView(v) {
  const { S, currentWorker, undoCount, voiceOn } = v;
  const items = S.shelfItems;
  const cur = items[S.currentIdx];
  const totalHere = items.length;
  const countedHere = items.filter((i) => S.counted[i.vnr] !== undefined).length;
  const pct = totalHere > 0 ? Math.round((countedHere / totalHere) * 100) : 0;
  const curCounted = cur ? S.counted[cur.vnr] : undefined;
  const isDone = curCounted !== undefined;
  const title = S.selectedShelf === "__CHECK__" ? "🔍 Tarkistettavat" : S.selectedShelf;
  const vnr = cur ? esc(cur.vnr) : "";

  const currentCard = cur ? `<div class="item-card current">
      <div style="font-size:12px;color:#94a3b8;margin-bottom:4px">${S.currentIdx + 1}/${totalHere}</div>
      <div style="font-size:16px;font-weight:700;margin-bottom:4px">${esc(cur.name)}</div>
      <div class="mono" style="color:#64748b;margin-bottom:8px">${esc(cur.location)} | VNR ${vnr}${cur.ean ? " | EAN " + esc(cur.ean) : ""}</div>
      <div style="text-align:center;margin-bottom:8px"><div style="font-size:12px;color:#64748b">Odotettu</div><div class="qty-big qty-expected">${cur.expected}</div></div>
      ${isDone ? `<div style="text-align:center;margin-bottom:12px"><div style="font-size:12px;color:#64748b">Inventoitu</div>
        <div class="qty-big ${curCounted === cur.expected ? "qty-match" : "qty-diff"}">${curCounted} ${curCounted === cur.expected ? "✓" : curCounted > cur.expected ? "▲" + (curCounted - cur.expected) : "▼" + (cur.expected - curCounted)}</div></div>` : ""}
      ${!S.camConfirmed && !isDone ? `
        <div style="text-align:center;font-size:13px;color:#7c3aed;font-weight:600;margin-bottom:8px">${S.device === "scanner" ? "🔫" : "📷"} Skannaa tuotteen viivakoodi</div>
        <button class="btn-sm btn-outline" style="width:100%;margin-bottom:8px" data-action="skip-scan">Ohita skannaus →</button>
      ` : `
        <div style="display:flex;align-items:center;justify-content:center;gap:16px;margin:16px 0">
          <button class="voice-btn ${voiceOn ? "listening" : "idle"}" data-action="${voiceOn ? "stop-voice" : "start-voice"}" data-vnr="${vnr}">${voiceOn ? "⏹" : "🎤"}</button></div>
        <input type="text" id="qty-input" class="scan-input" inputmode="numeric" placeholder="Syötä määrä tai skannaa" style="margin-bottom:8px" data-vnr="${vnr}">
      `}
    </div>` : `<div class="card" style="text-align:center;padding:24px">Hylly tyhjä</div>`;

  return `
    <div class="card"><div class="flex justify-between items-center"><h2 style="margin:0;color:#6d28d9">📍 ${esc(title)}</h2>
        <span style="font-size:12px;color:#94a3b8">${countedHere}/${totalHere} (${pct}%)</span></div>
      ${currentWorker ? `<div style="font-size:11px;color:#7c3aed;margin-top:2px">👤 ${esc(currentWorker)}</div>` : ""}
      <div class="progress-bar" style="margin-top:8px"><div class="progress-fill" style="width:${pct}%"></div></div></div>
    ${currentCard}
    ${result(S.result)}${err(S.error)}
    <div class="flex gap-8" style="margin-top:12px">
      <button class="btn-sm btn-outline flex-1" ${S.currentIdx === 0 ? "disabled" : ""} data-action="nav" data-delta="-1">←</button>
      <button class="btn-sm flex-1" style="background:${undoCount ? "#fef3c7" : "#f1f5f9"};color:${undoCount ? "#92400e" : "#cbd5e1"}" ${undoCount ? "" : "disabled"} data-action="undo">↩ Peru</button>
      <button class="btn-sm btn-outline flex-1" ${S.currentIdx >= items.length - 1 ? "disabled" : ""} data-action="nav" data-delta="1">→</button></div>
    <button class="btn" style="margin-top:12px;background:#16a34a" data-action="finish-shelf">Valmis → Valitse hylly</button>
    <details style="margin-top:12px"><summary style="font-size:13px;color:#64748b;cursor:pointer">Kaikki tuotteet (${totalHere})</summary>
      <div style="margin-top:8px;max-height:300px;overflow-y:auto">
        ${items.map((it, idx) => {
          const c = S.counted[it.vnr];
          const isCur = idx === S.currentIdx;
          const style = isCur ? "background:#ede9fe;border:1px solid #c4b5fd" : c !== undefined ? "background:#f0fdf4;border:1px solid #dcfce7;opacity:.6" : "background:#f8fafc;border:1px solid #e2e8f0";
          const col = c !== undefined && c !== it.expected ? "color:#dc2626" : c !== undefined ? "color:#16a34a" : "color:#94a3b8";
          return `<div style="padding:6px 8px;border-radius:6px;margin-bottom:3px;font-size:12px;cursor:pointer;${style}" data-action="goto" data-idx="${idx}">
            <div class="flex justify-between"><span style="font-weight:600">${esc(it.name)}</span><span style="white-space:nowrap;margin-left:8px;font-weight:700;${col}">${c !== undefined ? c + "/" + it.expected : it.expected}</span></div>
            <div class="mono" style="color:#94a3b8">${esc(it.location)}</div></div>`;
        }).join("")}
      </div></details>`;
}
