// Kamerapohjainen viivakoodinluku.
// Chrome/Android: selaimen oma BarcodeDetector. iOS Safari ja muut selaimet ilman BarcodeDetectoria: ZXing-kirjasto (ladataan vasta, kun kamera käynnistetään).
const ZXING_URL = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
const FORMATS = ["ean_13", "ean_8", "code_128", "code_39", "itf", "upc_a", "upc_e"];

export function cameraSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

let zxingPromise = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = ZXING_URL;
    s.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error("Viivakoodikirjasto ei latautunut")));
    s.onerror = () => { zxingPromise = null; reject(new Error("Viivakoodikirjaston lataus epäonnistui (tarkista verkkoyhteys)")); };
    document.head.appendChild(s);
  });
  return zxingPromise;
}

// Palauttaa funktion detect(video) → Promise<koodi | null>
async function makeDetector() {
  if ("BarcodeDetector" in window) {
    const d = new BarcodeDetector({ formats: FORMATS });
    return { slow: false, detect: async (video) => { const codes = await d.detect(video); return codes.length ? codes[0].rawValue : null; } };
  }
  const Z = await loadZxing();
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return {
    slow: true,
    detect: async (video) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      const scale = Math.min(1, 1280 / vw);
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
      try { return reader.decode(bitmap).getText(); } catch { return null; } // NotFoundException = ei koodia kuvassa
    },
  };
}

export function createCamera({ video, flash, onCode }) {
  let stream = null;
  let running = false;
  let detector = null;
  let last = "";
  let lastT = 0;

  async function openStream() {
    const attempts = [
      { video: { facingMode: { exact: "environment" } } },
      { video: { facingMode: "environment" } },
      { video: true },
    ];
    let lastErr;
    for (const c of attempts) {
      try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  async function loop() {
    if (!running) return;
    try {
      const code = await detector.detect(video);
      if (code) {
        const now = Date.now();
        if (!(code === last && now - lastT <= 2000)) {
          last = code; lastT = now;
          navigator.vibrate?.(100);
          if (flash) { flash.style.opacity = "1"; setTimeout(() => { flash.style.opacity = "0"; }, 200); }
          onCode(code);
        }
      }
    } catch { /* ei koodia tässä kuvassa */ }
    if (!running) return;
    if (detector.slow) setTimeout(loop, 120); // ZXing on raskaampi kuin BarcodeDetector: ~8 kuvaa/s riittää
    else requestAnimationFrame(loop);
  }

  return {
    get running() { return running; },
    async start() {
      this.stop();
      if (!cameraSupported()) throw new Error("Kamera-skannaus ei tuettu tässä selaimessa");
      // Kamera ensin (iOS Safari vaatii käyttäjän toiminnon lähellä), kirjasto sen jälkeen
      stream = await openStream();
      video.setAttribute("playsinline", "");
      video.muted = true;
      video.srcObject = stream;
      try { detector = await makeDetector(); } catch (e) { this.stop(); throw e; }
      await new Promise((resolve) => { video.onloadedmetadata = resolve; setTimeout(resolve, 2000); });
      await video.play();
      running = true;
      loop();
    },
    stop() {
      running = false;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      last = ""; lastT = 0;
    },
  };
}
