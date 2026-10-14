// Yhteinen kirjautumisnäkymä (Firebase-laitetili). Paikallisessa tilassa kirjautumista ei tarvita.
import { esc } from "./ui.js";

export function loginHtml(error) {
  return `<div class="card"><h1>Kirjaudu</h1><p class="sub">Kirjaudu laitteelle (kerran per laite)</p>
    <div class="mb-12"><label class="label">Sähköposti</label><input id="login-email" class="text-input" type="email" autocomplete="username"></div>
    <div class="mb-12"><label class="label">Salasana</label><input id="login-pass" class="text-input" type="password" autocomplete="current-password"></div>
    <button class="btn" data-action="login">Kirjaudu</button>${error ? `<div class="error">${esc(error)}</div>` : ""}</div>`;
}

// Palauttaa virheen tekstinä tai null kun onnistui.
export async function doLogin(store, emailEl, passEl) {
  try {
    await store.auth.signIn(emailEl.value.trim(), passEl.value);
    return null;
  } catch (e) {
    return "Kirjautuminen epäonnistui: " + (e.code || e.message);
  }
}
