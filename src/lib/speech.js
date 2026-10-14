// Puheentunnistus määrän syöttöön (fi-FI). Vaatii Chromen ja verkon.
import { parseFinnishInt } from "./spoken.js";

// Kokonaisluku puheesta (0–9999, myös yhdyssanat: "kolmekymmentäkuusi", "sata kaksikymmentä").
export function parseSpokenNumber(text) {
  const t = String(text).trim().toLowerCase();
  const lead = t.match(/^\d+/);
  if (lead) return parseInt(lead[0], 10); // "12" tai "12 kappaletta"
  return parseFinnishInt(t);
}

export function speechSupported() {
  return "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
}

// Kuuntelee puhetta ja välittää raakatekstin (esim. "oikein"/"väärin"/numero). Käynnistyy uudelleen itsestään,
// mutta lopettaa jos mikrofoni epäonnistuu toistuvasti (3 nopeaa uudelleenkäynnistystä, onError('mic-loop')).
export function listenText({ onText, onError, onStart }) {
  if (!speechSupported()) { onError?.("not-supported"); return { stop() {} }; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let active = true;
  let rec = null;
  let lastStart = 0;
  let rapid = 0;

  const start = () => {
    if (!active) return;
    const now = Date.now();
    rapid = now - lastStart < 1000 ? rapid + 1 : 0;
    if (rapid >= 3) { active = false; onError?.("mic-loop"); return; }
    lastStart = now;
    rec = new SR();
    rec.lang = "fi-FI";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => { if (active) onText(e.results[0][0].transcript); };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      active = false;
      onError?.(e.error);
    };
    rec.onend = () => { if (active) setTimeout(start, 300); };
    try { rec.start(); } catch { /* jo käynnissä */ }
  };

  start();
  onStart?.();
  return {
    stop() {
      active = false;
      if (rec) { try { rec.abort(); } catch { /* ei väliä */ } rec = null; }
    },
  };
}

// Kuuntelee kunnes pysäytetään. Käynnistyy uudelleen itsestään (no-speech/end). Palauttaa {stop}.
export function listenNumbers({ onNumber, onUnrecognized, onError, onStart }) {
  if (!speechSupported()) return { stop() {} };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let active = true;
  let rec = null;

  const start = () => {
    if (!active) return;
    rec = new SR();
    rec.lang = "fi-FI";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      const num = parseSpokenNumber(text);
      if (num === null) { onUnrecognized?.(text); return; }
      onNumber(num);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      active = false;
      onError?.(e.error);
    };
    rec.onend = () => { if (active) start(); };
    try { rec.start(); } catch { /* jo käynnissä */ }
  };

  start();
  onStart?.();
  return {
    stop() {
      active = false;
      if (rec) { try { rec.abort(); } catch { /* ei väliä */ } rec = null; }
    },
  };
}
