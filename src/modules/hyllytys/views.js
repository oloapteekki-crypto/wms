// Hyllytyksen näkymät: puhtaita funktioita (tila sisään, HTML-merkkijono ulos). Kaikki data esc():n kautta.
// Toiminnot kytketään data-action-attribuuteilla (ks. hyllytys.js).
import { esc } from "../../lib/ui.js";
import {
  CARTS, PLATES, cartDef, cartName, isSupplierCart, routeIndex, enrichItem, batchList, batchItems, batchRemaining, allScannedEnriched,
  totals, buildReport,
} from "./domain.js";

const badgeCls = (aisle) => "badge badge-" + (({ L: "L", F: "F", A: "A", B: "B", U: "U", R: "R", J: "J" })[aisle?.[0]] || "U");
const result = (r) => (r ? `<div class="scan-result ${r.type === "ok" ? "scan-ok" : "scan-fail"}">${esc(r.text)}</div>` : "");
const err = (e) => (e ? `<div class="error">${esc(e)}</div>` : "");
const pad2 = (n) => (n < 10 ? "0" : "") + n;

// Jakaa tuotteet hyllyittäin / reseptilääkkeisiin / UUSI-hyllyyn.
function groupItems(items) {
  const byShelf = {};
  const rx = [];
  const uusi = [];
  for (const i of items) {
    if (i.parsedLoc?.type === "rx") rx.push(i);
    else if (!i.location) uusi.push(i);
    else (byShelf[i.physAisle || "?"] ||= []).push(i);
  }
  const shelves = Object.keys(byShelf).sort((a, b) => routeIndex(a) - routeIndex(b));
  return { byShelf, shelves, rx, uusi };
}

const eanText = (i) => (i.ean && i.ean !== "null" ? " | EAN " + esc(i.ean) : "");

// Kärry ja levy tuotteen vieressä: tieto näkyy myös silloin, kun tuotetta ei voi hakea EAN:lla (esim. EAN ei toimi).
function cartTag(i) {
  const c = i.cartId ? CARTS.find((x) => x.id === i.cartId) : null;
  return c ? `<span style="font-weight:700;color:${c.color}">${c.icon} ${esc(c.name)}${i.plate ? " · levy " + i.plate : ""}</span>` : "";
}

function groupHtml(g, { detailed }) {
  let html = "";
  for (const shelf of g.shelves) {
    const cart = CARTS.find((c) => c.aisles.includes(shelf));
    const color = cart ? cart.color : "#94a3b8";
    html += detailed
      ? `<div style="margin-bottom:10px;padding:10px 12px;border-radius:8px;border-left:4px solid ${color};background:#fafbfc">
          <div style="font-size:13px;font-weight:700;margin-bottom:6px">${cart ? cart.icon : ""} ${esc(shelf)}</div>
          ${g.byShelf[shelf].map((i) => `<div style="padding:3px 0;font-size:12px"><div class="flex justify-between"><span>${esc(i.name)}</span><span style="font-weight:700;white-space:nowrap;margin-left:8px">${i.qty} kpl</span></div><div style="font-size:12px">${cartTag(i)}</div><div class="mono" style="color:#94a3b8">${esc(i.location || "—")}${eanText(i)}</div></div>`).join("")}
        </div>`
      : `<div style="margin:4px 0;padding:6px 8px;border-radius:6px;border-left:3px solid ${color};background:#fafbfc">
          <div style="font-size:11px;font-weight:700;margin-bottom:2px">${cart ? cart.icon : ""} ${esc(shelf)}</div>
          ${g.byShelf[shelf].map((i) => `<div style="font-size:11px;color:#475569;padding:1px 0 1px 8px">${esc(i.name)} <span style="color:#94a3b8">${i.qty} kpl → ${esc(i.location || "?")}${eanText(i)}</span> ${cartTag(i)}</div>`).join("")}
        </div>`;
  }
  if (g.rx.length) {
    html += detailed
      ? `<div style="margin-bottom:10px;padding:10px 12px;border-radius:8px;border-left:4px solid #b91c1c;background:#fef2f2"><div style="font-size:13px;font-weight:700;color:#b91c1c;margin-bottom:6px">💊 Reseptilääkkeet</div>${g.rx.map((i) => `<div style="font-size:12px;color:#7f1d1d;padding:3px 0">${esc(i.name)} → ${esc(i.location)} (${i.qty} kpl)</div>`).join("")}</div>`
      : `<div style="margin:4px 0 4px 8px"><span style="font-size:11px;font-weight:700">💊 RX:</span>${g.rx.map((i) => `<div style="font-size:11px;color:#7f1d1d;padding:1px 0 1px 12px">${esc(i.name)} → ${esc(i.location)}</div>`).join("")}</div>`;
  }
  if (g.uusi.length) {
    html += detailed
      ? `<div style="padding:10px 12px;border-radius:8px;border-left:4px solid #f59e0b;background:#fffbeb"><div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:6px">📦 UUSI-hyllyyn</div>${g.uusi.map((i) => `<div style="font-size:12px;color:#78350f;padding:3px 0">${esc(i.name)} (${i.qty} kpl)</div>`).join("")}</div>`
      : `<div style="margin:4px 0 4px 8px"><span style="font-size:11px;font-weight:700">📦 UUSI:</span>${g.uusi.map((i) => `<div style="font-size:11px;color:#78350f;padding:1px 0 1px 12px">${esc(i.name)} (${i.qty})</div>`).join("")}</div>`;
  }
  return html;
}

/* ───────── Kirjautuminen (Firebase) ───────── */
export function loginView(v) {
  return `<div class="card"><h1>Hyllytys</h1><p class="sub">Kirjaudu laitteelle (kerran per laite)</p>
    <div class="mb-12"><label class="label">Sähköposti</label><input id="login-email" class="text-input" type="email" autocomplete="username"></div>
    <div class="mb-12"><label class="label">Salasana</label><input id="login-pass" class="text-input" type="password" autocomplete="current-password"></div>
    <button class="btn" data-action="login">Kirjaudu</button>${err(v.S.error)}</div>`;
}

/* ───────── Aloitus ───────── */
export function setupView(v) {
  const { S, workers, currentWorker, storeKind } = v;
  return `
    ${storeKind === "local" ? `<div class="mode-banner">⚠ Paikallinen tila: data ei jakaudu laitteiden välillä. Täytä <code>src/config/firebase-config.js</code> jakaaksesi datan.</div>` : ""}
    <div class="card"><h1>Hyllytys</h1><p class="sub">Lataa päivän tiedot</p>
      <div class="mb-12"><label class="label">Käyttäjä</label>
        <select id="worker-select" class="select" data-change="worker">
          <option value="">— Valitse —</option>
          ${workers.map((w) => `<option value="${esc(w)}"${w === currentWorker ? " selected" : ""}>${esc(w)}</option>`).join("")}
        </select></div>
      <button class="btn" data-action="load" ${S.loadProgress ? "disabled" : ""}>${esc(S.loadProgress || "📱 Lataa tiedot")}</button>
      ${err(S.error)}${result(S.lastScanResult)}
    </div>
    <details class="card">
      <summary style="font-size:14px;font-weight:600;color:#1e40af;cursor:pointer">💻 Päivitä tiedostot (tietokone)</summary>
      <div style="margin-top:12px">
        <p style="font-size:12px;color:#64748b;margin-bottom:12px">Valitse tiedostot tietokoneelta. Muut laitteet hakevat ne automaattisesti.</p>
        <div class="mb-8"><label class="label">Tuoterekisteri (CSV)</label><input type="file" id="csv-upload" accept=".csv" style="font-size:14px;width:100%"></div>
        <div class="mb-8"><label class="label">Toimitusilmoitukset (XML) — valitse kaikki</label><input type="file" id="xml-upload" accept=".xml,.XML" multiple style="font-size:14px;width:100%"></div>
        <div class="mb-8"><label class="label">Inventointitapahtumat (MAXX, CSV) — laskettavat tuotteet</label><input type="file" id="inv-upload" accept=".csv,.CSV" style="font-size:14px;width:100%">
          <div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:#475569">Lasketaan tuotteet, joiden tappio on vähintään <input id="inv-threshold" type="number" min="1" value="100" style="width:70px;padding:4px;border:1px solid #cbd5e1;border-radius:6px"> €</div>
          <p style="font-size:11px;color:#94a3b8;margin-top:4px">${S.shrinkMeta ? `Nyt käytössä: ${S.shrinkMeta.count} tuotetta (tappio ≥ ${S.shrinkMeta.threshold} €${S.shrinkMeta.period ? ", " + esc(S.shrinkMeta.period) : ""}). Muut hyllytetään ilman laskentaa.` : "Ei listaa: kaikki tuotteet lasketaan. Lataa MAXX:n Inventointitapahtumat-raportti, jolloin lasketaan vain suuren hävikin tuotteet."}</p></div>
        <button class="btn" style="background:#1e40af" data-action="upload" ${S.loadProgress ? "disabled" : ""}>${esc(S.loadProgress || "Lataa tietokantaan")}</button>
        <p style="font-size:11px;color:#94a3b8;margin-top:8px">CSV:n voi ladata erikseen — vanhat XML:t korvataan uusilla</p>
      </div>
    </details>`;
}

/* ───────── Purku ───────── */
export function scanView(v) {
  const { S, fb, master, currentWorker } = v;
  const boxes = Object.keys(S.xmlBoxes);
  const scannedCount = Object.keys(fb.scannedBoxes).length;
  // Vastaanotto-moduulin viemät erät (ei XML:ssä) lasketaan mukaan nimittäjään, ettei laskuri näytä esim. 6/5
  const extraBoxes = Object.keys(fb.scannedBoxes).filter((k) => !(k in S.xmlBoxes)).length;
  const totalBoxes = boxes.length + extraBoxes;
  const all = allScannedEnriched(fb.scannedBoxes, master);
  let rxQ = 0, newQ = 0, palletQ = 0;
  for (const i of all) {
    if (i.parsedLoc?.type === "rx") rxQ += i.qty;
    else if (!i.parsedLoc) newQ += i.qty;
    else if (!i.cartId) palletQ += i.qty;
  }

  const pl = S.productLookup;
  const lookup = pl ? `<div class="card" style="border-left:4px solid ${pl.cart ? pl.cart.color : "#94a3b8"}">
      <div class="flex justify-between items-center mb-6"><h2 style="margin:0">Tuotehaku</h2><button class="btn-sm btn-outline" style="font-size:11px;padding:4px 10px" data-action="close-lookup">✕</button></div>
      <div style="font-size:15px;font-weight:600;margin-bottom:4px">${esc(pl.name)}</div>
      <div class="mono" style="color:#64748b;margin-bottom:8px">EAN ${esc(pl.ean)} | VNR ${esc(pl.sku)}</div>
      <div style="padding:10px;border-radius:8px;background:#f8fafc">
        <div style="font-size:14px;font-weight:700;margin-bottom:4px">${pl.cart ? esc(pl.cart.icon + " " + pl.cart.name) : pl.pa === "RX" ? "💊 Reseptilääke" : pl.pa === "JK" ? "❄️ Jääkaappi" : "📦 UUSI-hyllyyn"}</div>
        ${pl.plate ? `<div style="font-size:18px;font-weight:800;color:#1e293b">Levy ${pl.plate}</div>` : ""}
        <div style="font-size:13px;color:#475569">Paikka: <b>${esc(pl.location)}</b></div>
        ${pl.counted === false ? `<div style="font-size:13px;color:#64748b;margin-top:4px">Ei laskentaa — hyllytetään koko määrä</div>` : `<div style="font-size:13px;color:#b91c1c;margin-top:4px;font-weight:700">🔢 Laske kappaleet</div>`}
        ${pl.qty > 0 ? `<div style="font-size:13px;color:#475569;margin-top:4px">Skannatuissa laatikoissa: <b>${pl.qty} kpl</b></div>` : ""}
      </div></div>` : "";

  const unscanned = boxes.filter((k) => !fb.scannedBoxes[k.replace(/[.#$/[\]]/g, "_")]);
  const unscannedHtml = !unscanned.length
    ? `<div style="margin-top:8px;padding:8px;border-radius:8px;background:#f0fdf4;text-align:center;font-size:13px;color:#16a34a;font-weight:600">✓ Kaikki laatikot luettu!</div>`
    : `<details style="margin-top:10px"><summary style="font-size:12px;color:#64748b;cursor:pointer">Lukemattomat laatikot (${unscanned.length})</summary><div style="margin-top:6px">${unscanned.map((k) => {
        const items = S.xmlBoxes[k];
        const qty = items.reduce((s, i) => s + i.qty, 0);
        const detail = groupHtml(groupItems(items.map((i) => enrichItem(i, master))), { detailed: false });
        return `<details style="padding:6px 8px;border-radius:6px;margin-bottom:4px;background:#f8fafc;border:1px solid #e2e8f0">
          <summary style="display:flex;justify-content:space-between;align-items:center;font-size:12px;cursor:pointer"><span class="mono">...${esc(k.slice(-8))}</span><span style="color:#64748b">${items.length} tuot. / ${qty} kpl</span></summary>
          ${detail}
          <button class="btn-sm btn-info" style="width:100%;margin-top:6px;padding:6px;font-size:12px" data-action="add-box" data-code="${esc(k)}">Lisää laatikko</button></details>`;
      }).join("")}</div></details>`;

  let activeBox = "";
  if (S.activeBox) {
    const g = groupItems(S.activeBox.items.map((i) => (i.parsedLoc !== undefined ? i : enrichItem(i, master))));
    activeBox = `<div class="card"><div class="flex justify-between items-center mb-8"><h2 style="margin:0">Laatikko ...${esc(S.activeBox.sscc.slice(-6))}</h2>
      <button class="btn-sm btn-outline" style="font-size:11px;padding:4px 10px" data-action="close-box">✕ Sulje</button></div>
      ${groupHtml(g, { detailed: true })}
      <button class="btn-sm btn-danger" style="width:100%;margin-top:8px" data-action="remove-box" data-sscc="${esc(S.activeBox.sscc)}">Poista laatikko</button></div>`;
  }

  const carts = CARTS.map((c) => {
    const list = batchList(fb.cartBatches, c.id);
    const num = list[list.length - 1].num;
    const count = batchItems(fb.scannedBoxes, list[list.length - 1], c.id, master).length;
    return `<div style="padding:8px 12px;border-radius:8px;margin-bottom:6px;border-left:4px solid ${c.color};background:#fafbfc">
      <div class="flex justify-between items-center"><div>${c.icon} <b>${esc(c.name)} #${num}</b></div><span style="font-size:13px;font-weight:700">${count} tuotetta</span></div>
      ${count > 0 ? `<button class="btn-sm btn-info" style="margin-top:6px;width:100%;font-size:12px" data-action="close-batch" data-cart="${c.id}" data-num="${num}">Kärry valmis → Hyllytykseen</button>` : ""}
    </div>`;
  }).join("");

  const scannedList = scannedCount > 0 ? `<details class="card"><summary>Skannatut laatikot (${scannedCount})</summary>
    ${Object.entries(fb.scannedBoxes).map(([key, box]) => {
      const sscc = box.sscc || key;
      const cnt = box.items ? box.items.length : 0;
      const qty = box.items ? box.items.reduce((s, i) => s + i.qty, 0) : 0;
      return `<div class="flex justify-between items-center" style="padding:6px 0;border-bottom:1px solid #f1f5f9">
        <div data-action="show-box" data-key="${esc(key)}" style="cursor:pointer;flex:1"><span class="mono">...${esc(sscc.slice(-8))}</span> <span style="font-size:12px;color:#64748b">${cnt} tuot. / ${qty} kpl</span></div>
        <button class="btn-sm btn-danger" style="padding:4px 10px;font-size:11px" data-action="remove-box" data-sscc="${esc(sscc)}">Poista</button></div>`;
    }).join("")}</details>` : "";

  return `
    <div class="card"><h1>Purku</h1>
      <p class="sub"><span class="live-dot"></span><span id="live-counters">${scannedCount}/${totalBoxes} laatikkoa luettu</span>${currentWorker ? " — 👤 " + esc(currentWorker) : ""}</p>
      ${result(S.lastScanResult)}${err(S.error)}
      ${lookup}${unscannedHtml}</div>
    ${activeBox}
    <div class="card"><h2>Kärryt</h2>${carts}
      ${rxQ ? `<div style="padding:8px 12px;border-radius:8px;background:#fef2f2;font-size:13px;margin-bottom:6px">💊 Reseptilääkkeet: ${rxQ} kpl</div>` : ""}
      ${newQ ? `<div style="padding:8px 12px;border-radius:8px;background:#fffbeb;font-size:13px;margin-bottom:6px;border:1px solid #fde68a">📦 UUSI-hyllyyn: ${newQ} kpl <span style="font-size:11px;color:#92400e">(ei kärryissä — varastopaikkaa ei löydy)</span></div>` : ""}
      ${palletQ ? `<div style="padding:8px 12px;border-radius:8px;background:#f8fafc;font-size:13px;margin-bottom:6px;border:1px solid #e2e8f0">🏗 Lavapaikat (L4/L5): ${palletQ} kpl</div>` : ""}</div>
    ${scannedList}
    <button class="btn" style="background:#288264" data-action="to-cart-select">Valitse kärry → Hyllytys</button>
    <button class="btn-sm btn-danger" style="width:100%;margin-top:12px" data-action="reset-day">🗑 Nollaa päivän data</button>`;
}

/* ───────── Kärryn valinta ───────── */
export function cartSelectView(v) {
  const { fb, master, sessionId, now } = v;
  let cards = "";
  // Tukkutilausten kärryt ("A1") ja toimittajatilausten kärryt ("A1-V") ovat omia eriään, ja molempia voi hyllyttää yhtä aikaa.
  const sources = [...CARTS.map((c) => ({ c, key: c.id })), ...CARTS.map((c) => ({ c, key: c.id + "-V" }))];
  for (const { c, key } of sources) {
    const supplier = isSupplierCart(key);
    for (const batch of batchList(fb.cartBatches, key)) {
      const remaining = batchRemaining(fb.scannedBoxes, fb.shelved, batch, key, master);
      if (remaining === 0 && (batch.id !== "current" || supplier)) continue;
      const takenData = fb.cartsTaken[`${key}_${batch.id}`];
      const stale = takenData && now - takenData.t > 30 * 60 * 1000; // vapautuu 30 min jälkeen
      const taken = takenData && !stale;
      const mine = taken && takenData.by === sessionId;
      const isCurrent = batch.id === "current";
      const head = `<div style="font-size:16px;font-weight:700">${esc(c.name)} #${batch.num}</div>${supplier ? `<div style="font-size:12px;font-weight:700;color:#7c3aed">📦 Toimittajatilaus</div>` : `<div style="font-size:12px;color:#64748b">Tukkutilaus</div>`}`;
      const cnt = `<div style="font-size:18px;font-weight:800;margin:6px 0">${remaining} hyllyttämätöntä</div>`;
      if (taken && !mine) {
        cards += `<div class="cart-card" style="border-color:#94a3b8;opacity:.7"><div style="font-size:24px;margin-bottom:4px">🔒</div>${head}
          <div style="font-size:13px;color:#dc2626;margin:4px 0">Hyllytys kesken (toinen laite)</div>${cnt}
          <button class="btn-sm btn-danger" style="width:100%;margin-top:4px;font-size:12px" data-action="release-cart" data-cart="${key}" data-batch="${esc(batch.id)}">Vapauta lukitus</button></div>`;
      } else if (mine) {
        cards += `<div class="cart-card" style="border-color:${c.color}"><div style="font-size:24px;margin-bottom:4px">${c.icon}</div>${head}
          <div style="font-size:13px;color:#f59e0b;margin:4px 0">Oma hyllytys kesken</div>${cnt}
          <button class="btn-sm btn-info" style="width:100%;margin-top:4px;font-size:12px" data-action="select-cart" data-cart="${key}" data-batch="${esc(batch.id)}">Jatka hyllytystä</button></div>`;
      } else {
        const selectable = !isCurrent && remaining > 0;
        cards += `<div class="cart-card" style="border-color:${c.color}${selectable ? "" : ";opacity:.4;cursor:not-allowed"}" ${selectable ? `data-action="select-cart" data-cart="${key}" data-batch="${esc(batch.id)}"` : ""}>
          <div style="font-size:24px;margin-bottom:4px">${c.icon}</div>${head}
          <div style="font-size:13px;color:#64748b;margin:4px 0">${esc(c.desc)}</div>
          <details style="font-size:12px;color:#64748b;margin-bottom:4px"><summary>Levyt 1–5</summary>${(PLATES[c.id] || []).map((p, i) => `<div>Levy ${i + 1}: ${esc(p.label)}</div>`).join("")}</details>${cnt}
          ${isCurrent ? `<div style="font-size:11px;color:#3b82f6">⏳ Täyttyy — paina purussa "Kärry valmis"</div>` : ""}</div>`;
      }
    }
  }
  return `<div class="card"><h1>Valitse kärry</h1><p class="sub">Ota kärry ja aloita hyllytys</p>${err(v.S.error)}</div>${cards}
    <button class="btn-sm btn-outline" style="width:100%;margin-top:8px" data-action="to-scan">← Takaisin</button>`;
}

/* ───────── Hyllytys ───────── */
// Sama tuote usealla eri päiväyksellä (Vastaanotosta): lyhyin kesto eteen (FEFO), pidempi taakse.
function expiryNotice(item) {
  const dated = (item.exp || []).filter((g) => g.end);
  if (dated.length < 2) return "";
  const fmt = (ymd) => `${Number(ymd.slice(6))}.${Number(ymd.slice(4, 6))}.${ymd.slice(0, 4)}`;
  const first = dated[0];
  const rest = dated.slice(1).map((g) => `${g.qty} kpl, ${fmt(g.end)}`).join("; ");
  const undated = (item.exp || []).filter((g) => !g.end).reduce((s, g) => s + g.qty, 0);
  return `<div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:10px;padding:10px;margin-bottom:10px;font-size:13px;color:#92400e">
    <b>⚠ Useita eriä samaa tuotetta.</b> Laita <b>lyhyimmällä kestolla</b> oleva erä <b>eteen</b>: <b>${first.qty} kpl, ${fmt(first.end)}</b>.
    Pidempi kesto taakse: ${rest}.${undated ? ` Ilman päiväystä: ${undated} kpl.` : ""}</div>`;
}

export function shelveView(v) {
  const { S, currentWorker, elapsedSec, undoCount } = v;
  const { shelved: ts, expected: tq } = totals(S.routeItems, S.shelved);
  const pct = tq > 0 ? Math.round((ts / tq) * 100) : 0;
  const cur = S.routeItems[S.currentIdx];
  const cart = cartDef(S.selectedCart);
  const cc = S.shelved[cur.vnr] || 0;
  const done = cc >= cur.qty;
  const locOk = S.confirmedLoc && cur.location && cur.location.trim().toUpperCase() === S.confirmedLoc;
  const paused = !!S.pauseStart;
  const min = Math.floor(elapsedSec / 60);
  const sec = elapsedSec % 60;
  const vnr = esc(cur.vnr);

  const uncounted = cur.counted === false;
  // Varastopaikka näkyy aina ruudun yläreunassa (sticky), vaikka sisältöä vieritettäisiin.
  const locHtml = cur.parsedLoc
    ? `<span class="${badgeCls(cur.parsedLoc.aisle)}">${esc(cur.parsedLoc.aisle)}</span> <span class="location-big">${esc(cur.location)}</span>`
    : `<span class="location-big">📦 UUSI-hyllyyn</span>`;
  const counter = uncounted
    ? `<div style="margin-bottom:10px;font-size:13px;color:#64748b">Ei laskentaa: hyllytä koko määrä <b>${cur.qty} kpl</b></div>
      <button class="btn" style="background:${done ? "#16a34a" : "#288264"};padding:18px 0;font-size:18px" data-action="shelve-all" ${locOk || done ? "" : "disabled"}>${done ? "✓ Hyllytetty — seuraava" : locOk ? `✓ Hyllytetty (${cur.qty} kpl)` : "Skannaa ensin paikka"}</button>`
    : `<div style="display:inline-block;margin-bottom:8px;padding:3px 10px;border-radius:999px;background:#fef2f2;border:1px solid #fca5a5;color:#b91c1c;font-size:12px;font-weight:700">🔢 LASKE KAPPALEET — suuri hävikki</div>
      <div class="qty-display" style="background:${done ? "#f0fdf4" : "#f8fafc"};border:2px solid ${done ? "#86efac" : "#e2e8f0"}">
        <span style="font-size:36px;font-weight:800;color:${done ? "#16a34a" : "#1e293b"}">${cc}</span><span style="font-size:22px;color:#94a3b8"> / </span>
        <span style="font-size:36px;font-weight:800;color:#64748b">${cur.qty}</span>${done ? `<span style="font-size:24px;margin-left:8px">✓</span>` : ""}</div>
      <div class="qty-adj">
        <button class="qty-btn" style="color:#dc2626;border-color:#fca5a5" data-action="adjust" data-vnr="${vnr}" data-delta="-1">−</button>
        <input type="number" class="qty-manual" id="qty-manual" value="${cc}" min="0" data-change="qty-manual" data-vnr="${vnr}">
        <button class="qty-btn" style="color:#16a34a;border-color:#86efac" data-action="adjust" data-vnr="${vnr}" data-delta="1">+</button></div>`;

  return `
    <div class="sticky-loc" style="border-bottom-color:${cart?.color || "#64748b"}">
      <div class="flex justify-between items-center" style="font-size:12px;color:#475569;margin-bottom:2px"><span>${cart ? esc(cart.icon) : ""} <b>${esc(cartName(S.selectedCart))} #${S.selectedBatch?.num ?? ""}</b> — ${ts}/${tq} (${pct}%)</span><span>${S.currentIdx + 1}/${S.routeItems.length}</span></div>
      <div class="flex items-center gap-8">${locHtml}${cur.plate ? `<span style="margin-left:auto;padding:4px 12px;border-radius:10px;background:${cart?.color || "#64748b"};color:#fff;font-size:18px;font-weight:800;white-space:nowrap">Levy ${cur.plate}</span>` : ""}</div></div>
    <div class="mb-12">
      ${currentWorker ? `<div style="font-size:12px;color:#64748b;margin-bottom:4px">👤 ${esc(currentWorker)} — ⏱ <span id="clock">${min}:${pad2(sec)}${paused ? " — ⏸ TAUKO" : ""}</span></div>` : ""}
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div></div>

    <div class="card" style="border-left:4px solid ${cart?.color || "#64748b"}">
      <div style="font-size:15px;font-weight:600;margin-bottom:4px">${esc(cur.name)}</div>
      <div class="mono" style="color:#64748b;margin-bottom:10px">VNR ${vnr}${eanText(cur)}</div>
      ${expiryNotice(cur)}
      ${counter}</div>

    <div class="card">
      ${!locOk ? `<div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:8px">1. Skannaa paikka: <b>${esc(cur.location)}</b></div>`
        : `<div style="font-size:13px;font-weight:600;color:#16a34a;margin-bottom:8px">✓ ${esc(cur.location)} — 2. ${uncounted ? "Skannaa EAN tai paina Hyllytetty" : "Skannaa EAN"}</div>`}
      ${result(S.lastScanResult)}${err(S.error)}</div>

    <div class="flex gap-8 mb-12">
      <button class="btn-sm btn-outline flex-1" ${S.currentIdx === 0 ? "disabled" : ""} data-action="nav" data-delta="-1">←</button>
      <button class="btn-sm flex-1" style="background:${undoCount ? "#fef3c7" : "#f1f5f9"};color:${undoCount ? "#92400e" : "#cbd5e1"};border:none" ${undoCount ? "" : "disabled"} data-action="undo">↩ Peru</button>
      <button class="btn-sm flex-1" style="background:${paused ? "#f0fdf4" : "#fef2f2"};color:${paused ? "#16a34a" : "#64748b"};border:none" data-action="pause">${paused ? "▶ Jatka" : "⏸ Tauko"}</button>
      <button class="btn-sm btn-outline flex-1" ${S.currentIdx >= S.routeItems.length - 1 ? "disabled" : ""} data-action="nav" data-delta="1">→</button></div>
    <button class="btn" style="background:#288264;margin-bottom:12px" data-action="finish">Lopeta → Raportti</button>`;
}

/* ───────── Raportti ───────── */
export function reportView(v) {
  const { S, currentWorker, elapsedSec } = v;
  const rep = buildReport(S.routeItems, S.shelved);
  const { shelved: ts, expected: tq } = totals(S.routeItems, S.shelved);
  const cart = cartDef(S.selectedCart);
  const row = (cls, i, txt, color) => `<div class="report-row ${cls}"><div style="font-weight:600;font-size:12px">${esc(i.name)}</div><div style="font-weight:700;color:${color}">${txt}</div></div>`;
  return `
    <div class="card"><h1>${cart ? esc(cart.icon) : ""} ${esc(cartName(S.selectedCart))} #${S.selectedBatch?.num ?? ""} — Raportti</h1>
      ${S.shelveStartTime ? `<div style="font-size:13px;color:#64748b;margin-bottom:8px">${currentWorker ? "👤 " + esc(currentWorker) + " — " : ""}⏱ ${Math.floor(elapsedSec / 60)} min ${elapsedSec % 60} s</div>` : ""}
      <div class="flex gap-8" style="margin:12px 0">
        <div style="flex:1;padding:10px;border-radius:8px;background:#f0fdf4;text-align:center"><div style="font-size:22px;font-weight:700;color:#16a34a">${ts}</div><div style="font-size:11px;color:#047857">Hyllytetty</div></div>
        <div style="flex:1;padding:10px;border-radius:8px;background:#f8fafc;text-align:center"><div style="font-size:22px;font-weight:700">${tq}</div><div style="font-size:11px;color:#64748b">Odotettu</div></div>
        <div style="flex:1;padding:10px;border-radius:8px;background:${ts === tq ? "#f0fdf4" : "#fef2f2"};text-align:center"><div style="font-size:22px;font-weight:700;color:${ts === tq ? "#16a34a" : "#dc2626"}">${ts - tq}</div><div style="font-size:11px;color:#64748b">Erotus</div></div></div></div>
    ${rep.under.length ? `<div class="card"><h2 style="color:#92400e">Vajaita (${rep.under.length})</h2>${rep.under.map((i) => row("report-warn", i, `${i.sq}/${i.qty}`, "#92400e")).join("")}</div>` : ""}
    ${rep.notDone.length ? `<div class="card"><h2 style="color:#dc2626">Ei hyllytetty (${rep.notDone.length})</h2>${rep.notDone.map((i) => row("report-err", i, `0/${i.qty}`, "#dc2626")).join("")}</div>` : ""}
    ${rep.over.length ? `<div class="card"><h2 style="color:#7c3aed">Ylimäärä (${rep.over.length})</h2>${rep.over.map((i) => `<div class="report-row" style="background:#f5f3ff;border:1px solid #ddd6fe"><div style="font-weight:600;font-size:12px">${esc(i.name)}</div><div style="font-weight:700;color:#7c3aed">${i.sq}/${i.qty}</div></div>`).join("")}</div>` : ""}
    ${rep.ok.length ? `<details class="card"><summary style="color:#16a34a">OK (${rep.ok.length})</summary>${rep.ok.map((i) => row("report-ok", i, `${i.qty} ✓`, "#16a34a")).join("")}</details>` : ""}
    <div class="flex gap-8"><button class="btn-sm btn-outline flex-1" data-action="another-cart">Toinen kärry</button>
      <button class="btn flex-1" style="padding:10px" data-action="continue-unload">Jatka purkua</button></div>`;
}
