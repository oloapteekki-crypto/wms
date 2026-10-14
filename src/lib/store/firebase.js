// Firebase Realtime Database -toteutus tallennuskerrokselle. SDK ladataan vasta tarvittaessa (dynaaminen import),
// jotta paikallinen tila toimii ilman verkkoa ja ilman konfiguraatiota.
// Kirjautuminen: yhteinen laitetili (sähköposti + salasana) – Firebase Auth muistaa sen laitteella.
const SDK = "https://www.gstatic.com/firebasejs/10.12.2";

export async function createFirebaseStore(config) {
  const [{ initializeApp }, dbm, authm] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-database.js`),
    import(`${SDK}/firebase-auth.js`),
  ]);
  const app = initializeApp(config);
  const db = dbm.getDatabase(app);
  const auth = authm.getAuth(app);
  const r = (path) => dbm.ref(db, path);

  return {
    kind: "firebase",
    auth: {
      required: true,
      current: () => auth.currentUser,
      onChange: (cb) => authm.onAuthStateChanged(auth, cb),
      signIn: (email, password) => authm.signInWithEmailAndPassword(auth, email, password),
      signOut: () => authm.signOut(auth),
    },
    async get(path) { return (await dbm.get(r(path))).val(); },
    set: (path, value) => dbm.set(r(path), value),
    update: (path, obj) => dbm.update(r(path), obj),
    remove: (path) => dbm.remove(r(path)),
    // Atominen lisäys – kaksi laitetta ei ylikirjoita toistensa määriä.
    increment: (path, delta) => dbm.runTransaction(r(path), (cur) => (Number(cur) || 0) + delta),
    subscribe(path, cb) {
      const off = dbm.onValue(r(path), (snap) => cb(snap.val()));
      return off;
    },
  };
}
