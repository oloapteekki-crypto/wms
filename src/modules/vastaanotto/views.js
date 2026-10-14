// Vastaanoton näkymät (puhtaita funktioita; kaikki data esc():n kautta).
import { esc } from "../../lib/ui.js";
import { formatYmd } from "../../lib/spoken.js";
import { lineKey, lineStatus, summarize, splitToCarts, placement } from "./domain.js";

const STATUS = {
  pending: { label: "Odottaa", cls: "st-pending" },
  needsDate: { label: "Puuttuu pvm", cls: "st-date" },
  ok: { label: "OK", cls: "st-ok" },
  under: { label: "Vajaa", cls: "st-under" },
  over: { label: "Yli", cls: "st-over" },
  none: { label: "Ei tullut", cls: "st-none" },
};
const result = (r) => (r ? `<div class="scan-result ${r.type === "ok" ? "scan-ok" : "scan-fail"}">${esc(r.text)}</div>` : "");
const err = (e) => (e ? `<div class="error">${esc(e)}</div>` : "");

/* ───────── Aloitus ───────── */
export function startView(v) {
  const { S, workers, currentWorker, storeKind, recent } = v;
  return `
    <a class="back" href="../../../index.html">← WMS</a>
    ${storeKind === "local" ? `<div class="mode-banner">⚠ Paikallinen tila: vastaanotto ei jakaudu laitteiden välillä.</div>` : ""}
    <div class="card"><h1>📥 Toimittajatilauksen vastaanotto</h1>
      <div class="mb-12"><label class="label">Käyttäjä</label>
        <select class="select" data-change="worker"><option value="">— Valitse —</option>
          ${workers.map((w) => `<option value="${esc(w)}"${w === currentWorker ? " selected" : ""}>${esc(w)}</option>`).join("")}</select></div>
      <div class="mb-12"><label class="label">Lataa tilaus (Tilaukset-taulukko, .xlsx)</label>
        <input type="file" id="order-file" accept=".xlsx" style="font-size:14px;width:100%"></div>
      <button class="btn" data-action="load-file" ${S.loading ? "disabled" : ""}>${esc(S.loading || "Avaa tilaus")}</button>
      ${err(S.error)}${result(S.result)}</div>
    ${recent.length ? `<div class="card"><h2>Aiemmat tilaukset</h2>${recent.map((o) => `
      <div class="order-row" data-action="open-order" data-id="${esc(o.id)}">
        <div><b>${esc(o.supplier)}</b> <span class="muted">${esc(o.date)}</span></div>
        <div class="muted">${o.done}/${o.total} riviä${o.xmlAt ? " • XML tehty" : ""}</div></div>`).join("")}</div>` : ""}`;
}

/* ───────── Tilaus ───────── */
function lineCard(l, v) {
  const { S } = v;
  const key = l.key;
  const rec = S.recs[key] || {};
  const st = lineStatus(l, rec);
  const open = S.selectedKey === key;
  const sku = esc(l.sku);
  const received = rec.qty ?? "–";
  const dateTxt = rec.qty > 0 ? (rec.end ? formatYmd(rec.end) : rec.end === "" ? "ei pvm" : "pvm?") : "";
  const pl = placement(l, S.master);
  const chip = pl ? `<span class="where" style="border-color:${pl.color}">${pl.icon} ${esc(pl.label)}${pl.aisle ? " · levy " + esc(pl.aisle) : ""}${pl.location ? " · " + esc(pl.location) : ""}</span>` : "";
  const banner = open
    ? pl
      ? `<div class="cart-banner" style="border-color:${pl.color};background:${pl.color}18"><div class="cart-banner-label">${pl.kind === "cart" ? "Laita kärryyn" : "Ei kärryyn"}</div>
          <div class="cart-banner-main">${pl.icon} ${esc(pl.label)}</div>
          <div class="cart-banner-sub">${pl.aisle ? "Levy " + esc(pl.aisle) : ""}${pl.aisle && pl.location ? " · " : ""}${pl.location ? "paikka " + esc(pl.location) : pl.kind === "new" ? "ei hyllypaikkaa" : ""}</div></div>`
      : S.masterLoading ? `<div class="muted small" style="padding:8px 0">Haetaan hyllypaikkaa…</div>`
        : `<div class="muted small" style="padding:8px 0">Kärrytieto ei ole saatavilla (hyllypaikkoja ei ladattu).</div>`
    : "";
  let body = "";
  if (open) {
    const cand = S.voiceCandidate;
    body = `<div class="line-body">${banner}
      <div class="row">
        <button class="qbtn" data-action="qty-delta" data-key="${esc(key)}" data-delta="-1">−</button>
        <input type="number" inputmode="numeric" min="0" id="qty-input" class="qty-input" value="${rec.qty ?? ""}" placeholder="saapui" data-key="${esc(key)}">
        <button class="qbtn" data-action="qty-delta" data-key="${esc(key)}" data-delta="1">+</button>
        <button class="btn-sm btn-ok" data-action="all-came" data-key="${esc(key)}">✓ Kaikki tuli (${l.ordered})</button>
        <button class="btn-sm btn-danger" data-action="none-came" data-key="${esc(key)}">✗ Ei tullut</button>
      </div>
      ${rec.qty > 0 ? `<div class="row">
        <input type="date" id="end-date" class="date-input" value="${rec.end ? `${rec.end.slice(0, 4)}-${rec.end.slice(4, 6)}-${rec.end.slice(6)}` : ""}" data-key="${esc(key)}">
        <input type="text" id="end-text" class="date-text" placeholder="8/26 tai 16.12.2026" data-key="${esc(key)}" autocomplete="off">
        <button class="btn-sm btn-outline" data-action="no-date" data-key="${esc(key)}">Ei päiväystä</button>
      </div>` : ""}
      <div class="row">
        <button class="voice-btn ${v.voiceOn ? "listening" : "idle"}" data-action="${v.voiceOn ? "stop-voice" : "start-voice"}" data-key="${esc(key)}">${v.voiceOn ? "⏹" : "🎤"}</button>
        <div class="voice-help">${v.voiceOn ? esc(S.voiceText || "Kuuntelen…") : "Sano määrä ja päiväys. Kuittaa: oikein / väärin."}</div>
      </div>
      ${cand ? `<div class="scan-result scan-ok">${esc(cand)}</div>` : ""}
      ${l.ean ? "" : `<div class="muted small">Tuotteella ei ole EAN-koodia taulukossa.</div>`}
    </div>`;
  }
  return `<div class="line ${STATUS[st].cls}${open ? " open" : ""}" id="line-${sku}">
    <div class="line-head" data-action="select-line" data-key="${esc(key)}">
      <div class="line-main"><div class="line-name">${esc(l.name)}</div>
        <div class="mono muted">${sku}${l.ean ? " | EAN " + esc(l.ean) : ""}</div>${chip ? `<div>${chip}</div>` : ""}</div>
      <div class="line-qty"><div class="badge-st">${STATUS[st].label}</div>
        <div class="qtys"><b>${received}</b> / ${l.ordered}</div>${dateTxt ? `<div class="muted small">${esc(dateTxt)}</div>` : ""}</div>
    </div>${body}</div>`;
}

export function orderView(v) {
  const { S } = v;
  const { order, recs } = S;
  const sum = summarize(order.lines, recs);
  const pct = sum.total ? Math.round((sum.done / sum.total) * 100) : 0;
  const filtered = order.lines.filter((l) => {
    const st = lineStatus(l, recs[l.key]);
    const isDone = st !== "pending" && st !== "needsDate";
    return S.filter === "all" ? true : S.filter === "done" ? isDone : !isDone;
  });
  const tabs = [["lines", "Rivit"], ["carts", "Kärryt"], ["devs", "Poikkeamat"], ["xml", "XML"]];
  return `
    <button class="back linkbtn" data-action="to-start">← Tilaukset</button>
    <div class="card"><div class="flex justify-between items-center"><div><h1 style="margin:0">${esc(order.supplier.name)}</h1>
      <div class="muted small">Tilaus ${esc(formatYmd(order.orderDate))} • ${sum.total} riviä • ${sum.orderedUnits} kpl tilattu</div></div>
      <div class="big-pct">${sum.done}/${sum.total}</div></div>
      <div class="progress-bar" style="margin-top:8px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="chips">
        <span class="chip st-ok">OK ${sum.ok}</span><span class="chip st-under">Vajaa ${sum.under}</span><span class="chip st-over">Yli ${sum.over}</span>
        <span class="chip st-none">Ei tullut ${sum.none}</span><span class="chip st-date">Puuttuu pvm ${sum.needsDate}</span><span class="chip st-pending">Odottaa ${sum.pending}</span></div>
      <div class="scanrow"><input type="text" id="scan-field" class="scan-input" inputmode="numeric" placeholder="Skannaa tuotteen EAN" autocomplete="off">
        ${v.camOk ? `<button class="cam-btn${v.camOn ? " on" : ""}" data-action="toggle-cam">📷</button>` : ""}</div>
      <label class="small muted"><input type="checkbox" data-change="scan-adds" ${v.scanAdds ? "checked" : ""}> Skannaus lisää +1 saapuneeseen</label>
      ${result(S.result)}${err(S.error)}
      ${S.masterError ? `<div class="error">⚠ Kärrytieto ei näy: ${esc(S.masterError)} <button class="btn-sm btn-outline" data-action="load-master">Yritä uudelleen</button></div>` : ""}</div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab${S.tab === k ? " on" : ""}" data-action="tab" data-tab="${k}">${l}</button>`).join("")}</div>
    ${S.tab === "lines" ? linesTab(filtered, v, sum) : S.tab === "carts" ? cartsTab(v) : S.tab === "devs" ? devsTab(v) : xmlTab(v, sum)}`;
}

function linesTab(filtered, v, sum) {
  const { S } = v;
  const f = (k, label, n) => `<button class="chipbtn${S.filter === k ? " on" : ""}" data-action="filter" data-filter="${k}">${label} (${n})</button>`;
  return `<div class="filters">${f("open", "Kesken", sum.pending + sum.needsDate)}${f("done", "Valmiit", sum.done)}${f("all", "Kaikki", sum.total)}</div>
    ${filtered.length ? filtered.map((l) => lineCard(l, v)).join("") : `<div class="card empty">${S.filter === "open" ? "✓ Kaikki rivit käsitelty" : "Ei rivejä"}</div>`}`;
}

function cartsTab(v) {
  const { S } = v;
  if (S.masterLoading) return `<div class="card empty">Haetaan hyllypaikkoja…</div>`;
  if (!S.master) return `<div class="card"><div class="error">${esc(S.masterError || "Hyllypaikkoja ei ole ladattu")}</div><button class="btn" data-action="load-master">Yritä uudelleen</button></div>`;
  const { groups, items } = splitToCarts(S.order.lines, S.recs, S.master);
  if (!items.length) return `<div class="card empty">Ei saapuneita tuotteita vielä</div>`;
  const sent = S.shelvingSentAt;
  return `<div class="card"><div class="muted small">Saapuneet tuotteet jaettuna kärryihin hyllytysreitin mukaisessa järjestyksessä. ${items.length} tuotetta, ${items.reduce((s, i) => s + i.qty, 0)} kpl.</div>
      <button class="btn" style="margin-top:8px" data-action="to-shelving">${sent ? "↻ Päivitä hyllytykseen" : "➜ Siirrä hyllytykseen"}</button>
      ${sent ? `<div class="muted small">Viety hyllytykseen ${new Date(sent).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" })}. Uusi vienti korvaa edellisen.</div>` : ""}</div>
    ${groups.map((g) => `<div class="card" style="border-left:4px solid ${g.color}"><h2>${g.icon} ${esc(g.name)} <span class="muted small">${g.items.length} tuotetta, ${g.items.reduce((s, i) => s + i.qty, 0)} kpl</span></h2>
      ${g.items.map((i) => `<div class="cart-item"><div><div class="line-name">${esc(i.name)}</div><div class="mono muted">${esc(i.location || "ei paikkaa")}${i.ean ? " | EAN " + esc(i.ean) : ""}</div></div><div class="qtys"><b>${i.qty}</b> kpl</div></div>`).join("")}</div>`).join("")}`;
}

export function deviationRows(order, recs) {
  return order.lines.map((l) => ({ l, rec: recs[l.key] || {}, st: lineStatus(l, recs[l.key]) }))
    .filter((r) => ["under", "over", "none"].includes(r.st));
}

function devsTab(v) {
  const rows = deviationRows(v.S.order, v.S.recs);
  const sum = summarize(v.S.order.lines, v.S.recs);
  return `<div class="card"><h2>Poikkeamat (${rows.length})</h2>
    ${rows.length ? rows.map(({ l, rec, st }) => `<div class="cart-item ${STATUS[st].cls}"><div><div class="line-name">${esc(l.name)}</div><div class="mono muted">${esc(l.sku)}</div></div>
      <div class="qtys"><b>${rec.qty}</b> / ${l.ordered} <div class="muted small">${STATUS[st].label}</div></div></div>`).join("") : `<div class="empty">Ei poikkeamia</div>`}
    ${sum.pending + sum.needsDate ? `<div class="muted small">${sum.pending + sum.needsDate} riviä on vielä kesken.</div>` : ""}
    <div class="row" style="margin-top:8px"><button class="btn-sm btn-outline" data-action="copy-devs">📋 Kopioi viestiksi (Tia)</button><button class="btn-sm btn-outline" data-action="dl-devs">📥 CSV</button></div></div>`;
}

function xmlTab(v, sum) {
  const { S } = v;
  const open = sum.pending + sum.needsDate;
  return `<div class="card"><h2>Vastaanotto-XML</h2>
    <div class="muted small">${S.order.lines.length} riviä • saapunut ${sum.receivedUnits} / tilattu ${sum.orderedUnits} kpl</div>
    ${open ? `<div class="scan-result scan-fail">⚠ ${open} riviä on kesken. Käsittelemättömät menevät XML:ään määrällä 0.</div>` : `<div class="scan-result scan-ok">✓ Kaikki rivit käsitelty</div>`}
    <div class="muted small" style="margin:8px 0">Tiedosto: <b>${esc(v.xmlName)}</b>. Vie se MAXXin Tilauslahetteet-kansioon ja saavuta tilaus MAXXissa kuten ennenkin.</div>
    <div class="row"><button class="btn" data-action="dl-xml">📥 Lataa XML</button></div>
    ${v.dirOk ? `<div class="row" style="margin-top:8px"><button class="btn-sm btn-outline" style="flex:1" data-action="save-dir">📁 Tallenna suoraan kansioon…</button></div>
      <div class="muted small">Valitse kansio (esim. \\\\hq\\MAXX\\Tilauslahetteet). Toimii Chromessa; jos valinta ei onnistu, käytä latausta.</div>` : ""}
    ${S.xmlAt ? `<div class="muted small" style="margin-top:8px">Viimeksi tehty ${new Date(S.xmlAt).toLocaleString("fi-FI")}.</div>` : ""}
    ${result(S.result)}</div>`;
}
