// Puheentunnistus määrän syöttöön (fi-FI). Vaatii Chromen ja verkon.
const WORDS = {
  nolla: 0, yksi: 1, kaksi: 2, kolme: 3, neljä: 4, viisi: 5, kuusi: 6, seitsemän: 7, kahdeksan: 8, yhdeksän: 9, kymmenen: 10,
  yksitoista: 11, kaksitoista: 12, kolmetoista: 13, neljätoista: 14, viisitoista: 15, kuusitoista: 16,
  seitsemäntoista: 17, kahdeksantoista: 18, yhdeksäntoista: 19, kaksikymmentä: 20,
};

export function parseSpokenNumber(text) {
  const t = String(text).trim().toLowerCase();
  const n = parseInt(t, 10);
  if (!Number.isNaN(n)) return n;
  return t in WORDS ? WORDS[t] : null;
}

export function speechSupported() {
  return "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
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
