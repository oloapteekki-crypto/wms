// Valitsee tallennuskerroksen: Firebase jos src/config/firebase-config.js sisältää konfiguraation,
// muuten paikallinen (laitekohtainen) tila.
import firebaseConfig from "../../config/firebase-config.js";
import { createMemoryStore } from "./memory.js";

export async function createStore() {
  if (firebaseConfig) {
    const { createFirebaseStore } = await import("./firebase.js");
    return createFirebaseStore(firebaseConfig);
  }
  return createMemoryStore();
}

// Päivämäärä Suomen ajassa (YYYY-MM-DD). Vanhoissa apeissa käytettiin UTC:tä, jolloin päivä vaihtui klo 02/03.
export function todayKey(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Helsinki" }).format(date);
}
