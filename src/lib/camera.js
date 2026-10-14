// Kamerapohjainen viivakoodinluku (BarcodeDetector, Chrome/Android; ei iOS Safarissa).
export function cameraSupported() {
  return "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
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

  function loop() {
    if (!running) return;
    detector.detect(video).then((codes) => {
      if (!codes.length) return;
      const code = codes[0].rawValue;
      const now = Date.now();
      if (code === last && now - lastT <= 2000) return;
      last = code; lastT = now;
      navigator.vibrate?.(100);
      if (flash) { flash.style.opacity = "1"; setTimeout(() => { flash.style.opacity = "0"; }, 200); }
      onCode(code);
    }).catch(() => {});
    requestAnimationFrame(loop);
  }

  return {
    get running() { return running; },
    async start() {
      this.stop();
      if (!cameraSupported()) throw new Error("Kamera-skannaus ei tuettu tässä selaimessa");
      detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "code_39", "itf", "upc_a", "upc_e"] });
      stream = await openStream();
      video.srcObject = stream;
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
