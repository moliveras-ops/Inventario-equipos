// Sincronización en la nube (Firebase Firestore) — Inventario Equipos
// Los datos se siguen guardando en el teléfono (IndexedDB). Este módulo sube cada cambio
// a la nube y baja los cambios hechos en otros dispositivos. Sin señal, los cambios quedan
// en cola y se envían al recuperar la conexión.
const V = "10.14.1";
const cfg = window.FIREBASE_CONFIG;
const App = window.InvApp;               // funciones expuestas por index.html
const PARTE = 700 * 1024;                // tamaño de cada trozo de archivo adjunto (límite Firestore 1 MB)

let fs, auth, F, A, usuario = null, desuscribir = [], primeraCarga = {};

function estado(txt, tipo) { App.estadoSync(txt, tipo); }

async function iniciar() {
  if (!cfg || !cfg.apiKey || cfg.apiKey.startsWith("PEGAR")) { estado("Sincronización no configurada", "off"); return; }
  try {
    const [fa, fau, ffs] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`)
    ]);
    A = fau; F = ffs;
    const app = fa.initializeApp(cfg);
    auth = A.getAuth(app);
    try { fs = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
    catch { fs = F.getFirestore(app); }
    A.onAuthStateChanged(auth, u => { usuario = u; App.sesion(u ? u.email : null); u ? conectar() : desconectar(); });
  } catch (e) {
    console.warn("Sync:", e);
    estado("Sin conexión con la nube (se reintentará al abrir la app con señal)", "err");
    App.sesion(undefined);
  }
}

function desconectar() {
  desuscribir.forEach(f => f()); desuscribir = [];
  estado("No has iniciado sesión", "off");
}

function conectar() {
  desconectar();
  estado("Sincronizando…", "sync");
  primeraCarga = { equipos: true, config: true, archivos: true };
  desuscribir.push(F.onSnapshot(F.collection(fs, "equipos"), { includeMetadataChanges: true }, s => alRecibir("equipos", s), errSnap));
  desuscribir.push(F.onSnapshot(F.collection(fs, "config"), { includeMetadataChanges: true }, s => alRecibir("config", s), errSnap));
  desuscribir.push(F.onSnapshot(F.collection(fs, "archivos"), { includeMetadataChanges: true }, s => alRecibir("archivos", s), errSnap));
}
function errSnap(e) {
  console.warn("Sync:", e);
  estado(e.code === "permission-denied" ? "Tu usuario no tiene permiso en la base de datos" : "Error de sincronización: " + (e.code || e.message), "err");
}

/* ---------- Bajar cambios ---------- */
let pendienteRefresco = null;
function refrescar(q) { clearTimeout(pendienteRefresco); pendienteRefresco = setTimeout(() => App.refrescar(q), 250); }

async function alRecibir(col, snap) {
  const cambios = snap.docChanges();
  // la mezcla inicial se hace solo con datos confirmados por el servidor (no con la caché)
  const inicial = primeraCarga[col] && !snap.metadata.fromCache;
  const refr = {};
  if (col === "equipos") {
    for (const ch of cambios) {
      const r = ch.doc.data(), l = await App.local.get(ch.doc.id);
      if (ch.type === "removed") continue;
      if (r.borrado) { if (l && ts(l) <= r._u) { await App.local.del(ch.doc.id); refr.equipos = 1; } continue; }
      if (!l || ts(l) < r._u) { await App.local.put(r); refr.equipos = 1; }
    }
    if (inicial) {                       // subir lo local que la nube no tiene o que es más nuevo
      primeraCarga.equipos = false;
      const remoto = new Map(snap.docs.map(d => [d.id, d.data()]));
      for (const l of await App.local.all()) {
        const r = remoto.get(l.id);
        if (!r || ts(l) > r._u) subirEquipo(l);
      }
      for (const id of await App.local.pendBorr()) borrarEquipo(id);
      await App.local.pendBorr([]);
    }
    const pend = snap.metadata.hasPendingWrites;
    estado(pend ? "Cambios pendientes de subir (sin señal)" : "Sincronizado ✓", pend ? "sync" : "ok");
  }
  if (col === "config") {
    const remoto = {};
    for (const d of snap.docs) remoto[d.id] = d.data();
    if (inicial) {
      primeraCarga.config = false;
      const loc = await App.local.cfgAll();
      for (const [k, v] of Object.entries(loc)) {
        const r = remoto[k];
        if (!r) { subirCfg(k, v); continue; }
        const m = mezclarCfg(k, v, r.v);
        if (JSON.stringify(m) !== JSON.stringify(r.v)) subirCfg(k, m);
        if (JSON.stringify(m) !== JSON.stringify(v)) { await App.local.cfgSet(k, m); refr.config = 1; }
      }
      for (const [k, r] of Object.entries(remoto)) if (!(k in loc)) { await App.local.cfgSet(k, r.v); refr.config = 1; }
    } else {
      for (const ch of cambios) {
        if (ch.type === "removed") continue;
        await App.local.cfgSet(ch.doc.id, ch.doc.data().v); refr.config = 1;
      }
    }
  }
  if (col === "archivos") {
    for (const ch of cambios) {
      const r = ch.doc.data(), id = ch.doc.id, l = await App.local.docGet(id);
      if (r.borrado) { if (l && (l._u || 0) <= r._u) await App.local.docDel(id); continue; }
      if (l && (l._u || 0) < r._u) await App.local.docDel(id);   // versión vieja: se baja de nuevo al abrirlo
    }
    if (inicial) {
      primeraCarga.archivos = false;
      const remoto = new Map(snap.docs.map(d => [d.id, d.data()]));
      for (const l of await App.local.docAll()) {
        const r = remoto.get(l.id);
        if (!r || (l._u || 0) > r._u) subirArchivo(l);
      }
    }
  }
  if (refr.equipos || refr.config) refrescar(refr);
}

const ts = e => e._u || Date.parse(e.act || 0) || 0;

function mezclarCfg(k, loc, rem) {       // primera sincronización de un dispositivo: unir en vez de pisar
  if (k === "cats" && Array.isArray(loc) && Array.isArray(rem)) return [...new Set([...rem, ...loc])];
  if (k === "firmas" && Array.isArray(loc) && Array.isArray(rem)) return [...rem, ...loc.filter(f => !rem.some(x => x.id === f.id))];
  if (k.startsWith("certSeq_")) return Math.max(+loc || 0, +rem || 0);
  return rem;
}

/* ---------- Subir cambios ---------- */
const limpio = o => JSON.parse(JSON.stringify(o));   // Firestore no acepta undefined
function subirEquipo(e) { if (!usuario) return; F.setDoc(F.doc(fs, "equipos", e.id), limpio({ ...e, _u: ts(e) })).catch(errSnap); }
function borrarEquipo(id) { if (!usuario) return; F.setDoc(F.doc(fs, "equipos", id), { id, borrado: true, _u: Date.now() }).catch(errSnap); }
function subirCfg(k, v) { if (!usuario) return; F.setDoc(F.doc(fs, "config", k), { v: limpio(v ?? null), _u: Date.now() }).catch(errSnap); }

async function subirArchivo(d) {
  if (!usuario) return;
  const bytes = new Uint8Array(await d.data.arrayBuffer()), n = Math.ceil(bytes.length / PARTE) || 1;
  const _u = d._u || Date.now();
  // se encolan todas las escrituras de una vez (sin esperar): Firestore las envía en orden aunque no haya señal
  const w = [];
  for (let i = 0; i < n; i++)
    w.push(F.setDoc(F.doc(fs, "archivos", d.id, "partes", String(i)), { b: F.Bytes.fromUint8Array(bytes.slice(i * PARTE, (i + 1) * PARTE)) }));
  w.push(F.setDoc(F.doc(fs, "archivos", d.id), { nombre: d.nombre, tipo: d.tipo, n, size: bytes.length, _u }));
  Promise.all(w).catch(errSnap);
}
function borrarArchivo(id) { if (!usuario) return; F.setDoc(F.doc(fs, "archivos", id), { borrado: true, _u: Date.now() }).catch(errSnap); }

async function bajarArchivo(id) {
  if (!usuario) return null;
  try { return await bajarArchivo2(id); } catch (e) { console.warn("Sync:", e); return null; }
}
async function bajarArchivo2(id) {
  const m = await F.getDoc(F.doc(fs, "archivos", id));
  if (!m.exists() || m.data().borrado) return null;
  const { nombre, tipo, n, _u } = m.data(), partes = [];
  for (let i = 0; i < n; i++) partes.push((await F.getDoc(F.doc(fs, "archivos", id, "partes", String(i)))).data().b.toUint8Array());
  const d = { id, nombre, tipo, data: new Blob(partes, { type: tipo }), _u };
  await App.local.docPut(d);
  return d;
}

/* ---------- API para index.html ---------- */
window.Sync = {
  equipo: subirEquipo, borrarEquipo, cfg: subirCfg, archivo: subirArchivo, borrarArchivo, bajarArchivo,
  get activo() { return !!usuario; },
  get email() { return usuario && usuario.email; },
  get configurado() { return !!(cfg && cfg.apiKey && !cfg.apiKey.startsWith("PEGAR")); },
  async entrar(email, clave) { await A.signInWithEmailAndPassword(auth, email, clave); },
  async salir() { await A.signOut(auth); },
  async recuperar(email) { await A.sendPasswordResetEmail(auth, email); },
  forzar() { if (usuario) conectar(); }
};
iniciar();
