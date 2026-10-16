// Raportin laskenta (puhtaita funktioita, ei DOM-riippuvuuksia). Syöte tulee Firebasesta:
//   sessions/{pvm}/{performance, scannedBoxes, cartBatches, cartsTaken, progress}, scanLog/{pvm}, inventointi/*
// Korvaa vanhan tehoraportti.gs-sähköpostin reaaliaikaisella näkymällä.

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const values = (o) => Object.values(o || {});

const TZ = "Europe/Helsinki";
const hourFmt = new Intl.DateTimeFormat("fi-FI", { hour: "numeric", hourCycle: "h23", timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("fi-FI", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
export const hourOf = (t) => Number(hourFmt.format(new Date(t)));
export const timeOf = (t) => (t ? timeFmt.format(new Date(t)) : "");

export function fmtDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min ${s % 60} s`;
}

/* ───────── Hyllytys ───────── */
// performance: {id: {worker, cart, cartName, batch, start, end, elapsed(ms), shelved, expected, items, partial?}}
// Valmis erä korvaa saman id:n osittaisen tietueen, joten jäljelle jäävät partialit ovat keskeytyneitä eriä.
export function summarizeShelving(performance) {
  const entries = values(performance);
  const done = entries.filter((e) => !e.partial);
  const interrupted = entries.filter((e) => e.partial);
  const shelved = sum(done, (e) => e.shelved);
  const expected = sum(done, (e) => e.expected);
  const minutes = sum(done, (e) => e.elapsed) / 60000;

  const workers = {};
  for (const e of entries) {
    const w = (workers[e.worker || "(ei valittu)"] ||= { worker: e.worker || "(ei valittu)", batches: 0, interrupted: 0, shelved: 0, expected: 0, ms: 0 });
    if (e.partial) { w.interrupted++; continue; }
    w.batches++; w.shelved += e.shelved || 0; w.expected += e.expected || 0; w.ms += e.elapsed || 0;
  }
  const byWorker = Object.values(workers)
    .map((w) => ({ ...w, rate: w.ms > 0 ? w.shelved / (w.ms / 60000) : null, accuracy: w.expected > 0 ? w.shelved / w.expected : null }))
    .sort((a, b) => b.shelved - a.shelved);

  const batches = done
    .map((e) => ({ ...e, rate: e.elapsed > 0 ? (e.shelved || 0) / (e.elapsed / 60000) : null }))
    .sort((a, b) => (b.end || 0) - (a.end || 0));

  return {
    batchCount: done.length, interruptedCount: interrupted.length, shelved, expected,
    accuracy: expected > 0 ? shelved / expected : null, rate: minutes > 0 ? shelved / minutes : null,
    byWorker, batches,
  };
}

/* ───────── Skannausloki ───────── */
// scanLog: {id: {t, worker, cart, batch, vnr, name, location, added, total, expected, method}}
export function summarizeScanLog(scanLog) {
  const events = values(scanLog).sort((a, b) => (a.t || 0) - (b.t || 0));
  const perHour = {};
  const methods = { scan: 0, voice: 0, manual: 0 };
  let units = 0;
  for (const e of events) {
    if ((e.added || 0) > 0) {
      units += e.added;
      const h = hourOf(e.t);
      perHour[h] = (perHour[h] || 0) + e.added;
    }
    if (e.method in methods) methods[e.method]++;
  }
  const hours = Object.keys(perHour).map(Number);
  const hourly = [];
  if (hours.length) {
    const from = Math.min(...hours), to = Math.max(...hours);
    for (let h = from; h <= to; h++) hourly.push({ hour: h, units: perHour[h] || 0 });
  }
  return { events: events.length, units, hourly, methods, recent: events.slice(-12).reverse() };
}

/* ───────── Purku ja kärryt ───────── */
export function summarizeUnloading(session) {
  const boxes = values(session?.scannedBoxes);
  const unitsInBoxes = sum(boxes, (b) => sum(b.items || [], (i) => i.qty));
  const closed = {};
  for (const [cart, batches] of Object.entries(session?.cartBatches || {})) closed[cart] = Object.keys(batches).length;
  return { boxes: boxes.length, unitsInBoxes, closedBatches: closed };
}

// Käynnissä nyt: kärrylukitukset ja hyllytyksen etenemä (progress). Yli 30 min vanha lukitus on "jumissa".
export function activeNow(session, now) {
  const progress = session?.progress || {};
  const rows = [];
  for (const [key, lock] of Object.entries(session?.cartsTaken || {})) {
    const cart = key.split("_")[0];
    const prog = progress[`${key}_progress`];
    const lastT = Math.max(lock.t || 0, prog?.t || 0);
    rows.push({
      key, cart, units: prog ? sum(values(prog.shelved), (n) => n) : 0,
      ageMin: Math.floor((now - lastT) / 60000), stale: now - lastT > 30 * 60 * 1000,
    });
  }
  return rows.sort((a, b) => a.ageMin - b.ageMin);
}

/* ───────── Inventointi ───────── */
// counted: {vnr: {qty, name, location, worker, t, date}}, products: {vnr: {expected, location, ...}}, dismissed: {vnr: ...}
export function summarizeInventory(counted, products, dismissed, date) {
  const todays = Object.entries(counted || {}).filter(([, c]) => c.date === date);
  let deviations = 0, absUnits = 0, dismissedToday = 0;
  const workers = {};
  for (const [vnr, c] of todays) {
    (workers[c.worker || "(ei valittu)"] = (workers[c.worker || "(ei valittu)"] || 0) + 1);
    const diff = c.qty - (products?.[vnr]?.expected || 0);
    if (diff === 0) continue;
    if (dismissed?.[vnr]) { dismissedToday++; continue; }
    deviations++; absUnits += Math.abs(diff);
  }
  const shelves = {};
  for (const [vnr, p] of Object.entries(products || {})) {
    const parts = (p.location || "").split("-");
    if (parts.length < 3) continue;
    const key = parts[0] + "-" + parts[1];
    const s = (shelves[key] ||= { total: 0, counted: 0 });
    s.total++;
    if (counted?.[vnr]) s.counted++;
  }
  const keys = Object.keys(shelves);
  const shelvesDone = keys.filter((k) => shelves[k].total > 0 && shelves[k].counted === shelves[k].total).length;
  return {
    countedToday: todays.length, deviations, absUnits, dismissedToday,
    byWorker: Object.entries(workers).map(([worker, n]) => ({ worker, n })).sort((a, b) => b.n - a.n),
    shelvesTotal: keys.length, shelvesDone,
  };
}

/* ───────── Siirrot ───────── */
// transfers: sessions/{pvm}/siirrot = {avain(sku|from|to): {state: claimed|picked|placed|skipped, by, t, batch}}
const CLAIM_TTL = 90 * 60 * 1000;
export function summarizeTransfers(transfers, now = Date.now()) {
  const counts = { claimed: 0, picked: 0, placed: 0, skipped: 0 };
  const workers = {};
  const recent = [];
  for (const [key, r] of Object.entries(transfers || {})) {
    if (!r || !counts.hasOwnProperty(r.state)) continue;
    if (r.state === "claimed" && now - (r.t || 0) > CLAIM_TTL) continue; // vanhentunut varaus = vapaa
    counts[r.state]++;
    const w = (workers[r.by || "(ei valittu)"] ||= { worker: r.by || "(ei valittu)", claimed: 0, picked: 0, placed: 0, skipped: 0 });
    w[r.state]++;
    if (r.state === "picked" || r.state === "placed") {
      const [sku, from, to] = key.split("|");
      recent.push({ t: r.t || 0, worker: r.by, state: r.state, sku, from, to });
    }
  }
  return {
    ...counts,
    total: counts.claimed + counts.picked + counts.placed + counts.skipped,
    byWorker: Object.values(workers).sort((a, b) => b.placed - a.placed || b.picked - a.picked),
    recent: recent.sort((a, b) => b.t - a.t).slice(0, 12),
  };
}
/* ───────── Vastaanotto (toimittajatilaukset) ───────── */
// orders: vastaanotto = {tilaus: {meta, lines, rec: {rivi: {b: {erä: {qty,end,t,by}}, none?, t?, by?}}, arrival: {t,by}, completion: {t,by}}}
// Odotus = saapumisesta purun alkuun (tai nykyhetkeen, jos purku ei ole alkanut). Kesto = purun alusta valmistumiseen.
// Työaika = peräkkäisten kirjausten välit, jotka ovat enintään 10 min (tauot eivät kasva työajaksi).
const dayOf = (t) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date(t));
const WORK_GAP_MS = 10 * 60 * 1000;

export function summarizeReceiving(orders, date, now = Date.now()) {
  const rows = [];
  for (const [id, o] of Object.entries(orders || {})) {
    if (!o?.meta) continue;
    const times = [];
    const workers = {};
    let received = 0;
    for (const r of values(o.rec)) {
      for (const b of values(r.b)) { if (b.t) { times.push(b.t); workers[b.by || "(ei valittu)"] = (workers[b.by || "(ei valittu)"] || 0) + 1; } received += Number(b.qty) || 0; }
      if (r.none && r.t) { times.push(r.t); workers[r.by || "(ei valittu)"] = (workers[r.by || "(ei valittu)"] || 0) + 1; }
    }
    times.sort((a, b) => a - b);
    const arrival = o.arrival?.t || null;
    const completion = o.completion?.t || null;
    const started = times[0] || null;
    const last = times[times.length - 1] || null;
    const days = [arrival, started, completion, last].filter(Boolean).map(dayOf);
    const open = !completion; // keskeneräinen näkyy aina kuluvana päivänä
    const isToday = date === dayOf(now);
    if (!days.includes(date) && !(isToday && open && (arrival || started))) continue;
    let work = 0;
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= WORK_GAP_MS) work += times[i] - times[i - 1];
    const lines = Object.values(o.lines || {});
    rows.push({
      id, supplier: o.meta.supplier?.name || id, orderDate: o.meta.orderDate || "",
      status: completion ? "done" : started ? "progress" : "waiting",
      lines: lines.length, ordered: sum(lines, (l) => l.ordered), received,
      arrival, started, completion,
      waitMs: arrival ? (started ? started - arrival : now - arrival) : null,
      durationMs: started ? (completion || now) - started : null,
      workMs: started ? work : null,
      workers: Object.entries(workers).sort((a, b) => b[1] - a[1]).map(([w]) => w),
    });
  }
  const order = { waiting: 0, progress: 1, done: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || (a.status === "waiting" ? (a.arrival || 0) - (b.arrival || 0) : (b.completion || b.started || 0) - (a.completion || a.started || 0)));
  const done = rows.filter((r) => r.status === "done");
  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
  const waiting = rows.filter((r) => r.status === "waiting" && r.arrival);
  return {
    rows, doneCount: done.length, waitingCount: waiting.length, progressCount: rows.filter((r) => r.status === "progress").length,
    longestWaitMs: waiting.length ? Math.max(...waiting.map((r) => r.waitMs)) : null,
    avgDurationMs: avg(done.map((r) => r.durationMs).filter((x) => x !== null)),
    avgWorkMs: avg(done.map((r) => r.workMs).filter((x) => x !== null)),
    avgWaitMs: avg(rows.filter((r) => r.started && r.arrival).map((r) => r.waitMs)),
  };
}