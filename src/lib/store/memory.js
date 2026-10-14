// Paikallinen tallennuskerros (ei jaettu laitteiden välillä). Käytössä kun Firebasea ei ole konfiguroitu,
// ja testeissä. Sama rajapinta kuin firebase.js. Data säilyy localStorageen.
const LS_KEY = "wms_local_store";

function split(path) {
  return path.split("/").filter(Boolean);
}

export function createMemoryStore({ persist = true } = {}) {
  let root = {};
  if (persist) {
    try { root = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { root = {}; }
  }
  const listeners = new Set(); // {path, cb}

  const save = () => {
    if (persist) try { localStorage.setItem(LS_KEY, JSON.stringify(root)); } catch { /* ei tallennusta */ }
  };

  function read(path) {
    let node = root;
    for (const k of split(path)) {
      if (node == null || typeof node !== "object") return null;
      node = node[k];
    }
    return node === undefined ? null : node;
  }

  function write(path, value) {
    const keys = split(path);
    if (!keys.length) { root = value ?? {}; return; }
    let node = root;
    for (const k of keys.slice(0, -1)) {
      if (node[k] == null || typeof node[k] !== "object") node[k] = {};
      node = node[k];
    }
    const last = keys[keys.length - 1];
    if (value === null || value === undefined) delete node[last];
    else node[last] = value;
  }

  const overlaps = (a, b) => a.startsWith(b) || b.startsWith(a);

  function notify(changedPath) {
    const norm = "/" + split(changedPath).join("/");
    for (const l of listeners) {
      const lp = "/" + split(l.path).join("/");
      if (overlaps(norm, lp)) l.cb(structuredClone(read(l.path)));
    }
  }

  return {
    kind: "local",
    auth: {
      required: false,
      current: () => ({ uid: "local" }),
      onChange: (cb) => { cb({ uid: "local" }); return () => {}; },
      signIn: async () => {},
      signOut: async () => {},
    },
    async get(path) { return structuredClone(read(path)); },
    async set(path, value) { write(path, structuredClone(value)); save(); notify(path); },
    async update(path, obj) {
      for (const [k, v] of Object.entries(obj)) write(`${path}/${k}`, structuredClone(v));
      save(); notify(path);
    },
    async remove(path) { write(path, null); save(); notify(path); },
    async increment(path, delta) {
      write(path, (Number(read(path)) || 0) + delta); save(); notify(path);
    },
    subscribe(path, cb) {
      const l = { path, cb };
      listeners.add(l);
      cb(structuredClone(read(path)));
      return () => listeners.delete(l);
    },
  };
}
