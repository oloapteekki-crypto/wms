// Yhteiset käyttöliittymäapurit.

// Kaikki dataperäinen teksti HTML:ään tämän kautta (estää XSS:n).
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export const $ = (id) => document.getElementById(id);

export function show(el, visible, display = "block") {
  el.style.display = visible ? display : "none";
}
