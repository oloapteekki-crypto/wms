// localStorage-apurit. Kaikki kutsut suojattu: yksityinen selaus tai täysi tallennustila ei kaada appia.

export function loadJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ei tallennusta */ }
}

export function removeKeys(...keys) {
  try { keys.forEach((k) => localStorage.removeItem(k)); } catch { /* ei tallennusta */ }
}
