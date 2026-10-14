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
