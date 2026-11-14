// Service Worker der verschlüsselten Kartenseite (Vorlage für tools/web_verschluesseln.py).
// Alles unter app/ wird aus e/<name>.bin geladen und mit dem Schlüssel aus IndexedDB entschlüsselt.
// e/<name>.bin ändert sich nie (Name hängt vom Inhalt ab) → Cache zuerst; e/index.bin → Netz zuerst.
const VERSION = 'dadf6844c3';
const CACHE = 'wissen-daten';
const SCHALE = 'wissen-schale-' + VERSION;
const BASIS = new URL('./', self.location).href;
const APP = new URL('app/', BASIS);

let zustand = null;            // {key, index, zeit}

function db() {
  return new Promise((ok, fehler) => {
    const r = indexedDB.open('wissen', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fehler(r.error);
  });
}
async function dbGet(name) {
  const d = await db();
  return new Promise((ok, fehler) => {
    const r = d.transaction('k').objectStore('k').get(name);
    r.onsuccess = () => ok(r.result); r.onerror = () => fehler(r.error);
  });
}
async function dbDel(name) {
  const d = await db();
  return new Promise((ok) => { const t = d.transaction('k', 'readwrite'); t.objectStore('k').delete(name); t.oncomplete = ok; t.onerror = ok; });
}

async function entschluesseln(key, buf) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
}

async function netzZuerst(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (r.ok) { const c = await caches.open(CACHE); await c.put(url, r.clone()); return r.arrayBuffer(); }
  } catch (e) { /* offline */ }
  const t = await caches.match(url);
  if (t) return t.arrayBuffer();
  throw new Error('nicht erreichbar');
}

async function cacheZuerst(url) {
  const t = await caches.match(url);
  if (t) return t.arrayBuffer();
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const c = await caches.open(CACHE);
  await c.put(url, r.clone());
  return r.arrayBuffer();
}

async function aufraeumen(index) {
  const gueltig = new Set(Object.values(index).map((n) => new URL('e/' + n + '.bin', BASIS).href));
  gueltig.add(new URL('e/index.bin', BASIS).href);
  const c = await caches.open(CACHE);
  for (const a of await c.keys()) if (!gueltig.has(a.url)) await c.delete(a);
}

async function laden(frisch) {
  if (zustand && !(frisch && Date.now() - zustand.zeit > 60000)) return zustand;
  const key = await dbGet('key');
  if (!key) { zustand = null; return null; }
  const buf = await netzZuerst(new URL('e/index.bin', BASIS).href);
  let index;
  try {
    index = JSON.parse(new TextDecoder().decode(await entschluesseln(key, buf)));
  } catch (e) {                         // Passwort wurde geändert → neu anmelden
    await dbDel('key');
    zustand = null;
    return null;
  }
  zustand = { key, index, zeit: Date.now() };
  aufraeumen(index).catch(() => {});
  return zustand;
}

const TYPEN = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  svg: 'image/svg+xml', gif: 'image/gif', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8',
};

async function antwort(rel, anfrage) {
  const navi = anfrage.mode === 'navigate';
  let z = null;
  try { z = await laden(navi); } catch (e) { /* offline und nichts im Cache */ }
  if (!z) {
    if (navi) return Response.redirect(new URL('index.html', BASIS).href, 302);
    return new Response('Nicht angemeldet', { status: 401 });
  }
  const name = z.index[rel];
  if (!name) return new Response('Nicht gefunden', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  try {
    const klar = await entschluesseln(z.key, await cacheZuerst(new URL('e/' + name + '.bin', BASIS).href));
    const endung = rel.split('.').pop().toLowerCase();
    return new Response(klar, { headers: { 'Content-Type': TYPEN[endung] || 'application/octet-stream' } });
  } catch (e) {
    return new Response('Offline – diese Karte wurde noch nicht geladen.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SCHALE).then((c) => c.addAll(['./', './index.html', './schluessel.json', './manifest.webmanifest', './icons/icon-192.png']))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((n) => Promise.all(n.filter((x) => x.startsWith('wissen-schale-') && x !== SCHALE).map((x) => caches.delete(x))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => { if (e.data === 'neu') zustand = null; });

self.addEventListener('fetch', (e) => {
  const a = e.request;
  if (a.method !== 'GET') return;
  const u = new URL(a.url);
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith(APP.pathname)) {
    let rel = decodeURIComponent(u.pathname.slice(APP.pathname.length));
    if (!rel || rel.endsWith('/')) rel += 'uebersicht.html';
    e.respondWith(antwort(rel, a));
    return;
  }
  if (u.pathname.includes('/e/')) return;            // Datenabrufe des Workers selbst
  // öffentliche Schale: Netz zuerst, offline aus dem Cache
  e.respondWith(fetch(a).then((r) => {
    if (r.ok && !u.search) { const k = r.clone(); caches.open(SCHALE).then((c) => c.put(a, k)); }
    return r;
  }).catch(() => caches.match(a, { ignoreSearch: true }).then((t) => t || caches.match('./index.html'))));
});
