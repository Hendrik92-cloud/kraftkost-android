/**
 * Updates ohne Neuinstallation.
 * Jeder Build legt auf GitHub neben der APK den Web-Teil (web.zip) und version.json ab.
 * Hat sich nur der Web-Teil geändert (fast immer), lädt die App ihn still herunter und
 * startet beim nächsten Öffnen damit. Nur wenn sich Nativ-Teile geändert haben,
 * bietet sie die neue APK an – dann reicht ein Tipp auf „Installieren“.
 */
import { Capacitor, CapacitorHttp, WebView, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import JSZip from 'jszip';
import { $, esc, toast } from './util.js';
import { flush } from './store.js';

/* global __BUILD__, __NATIVE__ */
export const BUILD = __BUILD__;
const NATIVE = __NATIVE__;
const REL = 'https://github.com/Hendrik92-cloud/kraftkost-android/releases';
const Kraft = registerPlugin('Kraft');
const PENDING = 'kk-update-pending';
const native = Capacitor.isNativePlatform();

let state = { busy: false, last: 0, info: '', apk: null };
const setInfo = t => { state.info = t; const el = $('#up-info'); if (el) el.textContent = t; };

async function getJSON(url) {
  const r = await CapacitorHttp.get({ url: url + '?t=' + Date.now(), connectTimeout: 15000, readTimeout: 20000, responseType: 'text' });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}

async function download(url, path) {
  await Filesystem.downloadFile({ url, path, directory: Directory.Cache, recursive: true });
  return (await Filesystem.getUri({ path, directory: Directory.Cache })).uri;
}

/** Web-Teil laden, entpacken und für den nächsten Start vormerken. */
async function installWeb(v) {
  setInfo(`Lade Version ${v.build} …`);
  await download(`${REL}/download/build-${v.build}/web.zip`, 'upd/web.zip');
  const { data } = await Filesystem.readFile({ path: 'upd/web.zip', directory: Directory.Cache });
  const zip = await JSZip.loadAsync(data, { base64: true });
  if (!zip.file('index.html')) throw new Error('Paket unvollständig');
  const dir = `web/b${v.build}`;
  try { await Filesystem.rmdir({ path: dir, directory: Directory.Data, recursive: true }); } catch { /* gab es nicht */ }
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue;
    await Filesystem.writeFile({ path: `${dir}/${f.name}`, directory: Directory.Data, data: await f.async('base64'), recursive: true });
  }
  await Filesystem.deleteFile({ path: 'upd/web.zip', directory: Directory.Cache }).catch(() => {});
  const uri = (await Filesystem.getUri({ path: dir, directory: Directory.Data })).uri;
  localStorage.setItem(PENDING, JSON.stringify({ build: v.build, path: decodeURI(uri.replace(/^file:\/\//, '')) }));
  setInfo(`Version ${v.build} ist bereit.`);
  banner(`Neue Version ${v.build} ist da.`, 'Jetzt neu laden', applyPending);
}

/** Vorgemerkte Version aktivieren (lädt die App neu). */
async function applyPending() {
  const p = JSON.parse(localStorage.getItem(PENDING) || 'null');
  if (!p || p.build <= BUILD) { localStorage.removeItem(PENDING); return false; }
  localStorage.removeItem(PENDING);
  await flush();
  await WebView.setServerBasePath({ path: p.path });
  return true;
}

async function installApk() {
  const v = state.apk; if (!v) return;
  try {
    setInfo(`Lade App-Version ${v.build} …`); toast('Lade die neue App …');
    const uri = await download(`${REL}/download/build-${v.build}/Kraftkost.apk`, 'upd/Kraftkost.apk');
    await Kraft.installApk({ path: uri });
    setInfo('Tippe im Android-Fenster auf „Installieren“.');
  } catch (e) {
    if (e?.code === 'permission') setInfo('Erlaube Kraftkost einmalig, Apps zu installieren, geh zurück und tippe nochmal auf „Installieren“.');
    else setInfo('Das Herunterladen hat nicht geklappt. Versuch es nochmal, am besten im WLAN.');
  }
}

function banner(text, label, fn) {
  const b = $('#upd'); if (!b) return;
  b.innerHTML = `<span>${esc(text)}</span><button type="button" class="primary small">${esc(label)}</button>`;
  b.hidden = false;
  b.querySelector('button').onclick = () => { b.hidden = true; fn(); };
}

/** Auf GitHub nach einer neueren Version schauen. */
export async function checkUpdate({ force = false } = {}) {
  if (!native || state.busy) return;
  if (!force && Date.now() - state.last < 20 * 60 * 1000) return;
  state.busy = true; state.last = Date.now();
  if (force) setInfo('Suche nach Updates …');
  try {
    const v = await getJSON(`${REL}/latest/download/version.json`);
    const pend = JSON.parse(localStorage.getItem(PENDING) || 'null');
    if (!v?.build || v.build <= BUILD) setInfo(`Version ${BUILD} ist aktuell.`);
    else if (v.native !== NATIVE) {
      state.apk = v;
      setInfo(`App-Version ${v.build} braucht eine kurze Installation.`);
      banner(`Neue App-Version ${v.build}: einmal installieren.`, 'Installieren', installApk);
    } else if (pend?.build === v.build) {
      setInfo(`Version ${v.build} ist bereit.`);
      banner(`Neue Version ${v.build} ist da.`, 'Jetzt neu laden', applyPending);
    } else await installWeb(v);
  } catch {
    if (force) setInfo('Keine Verbindung zu GitHub. Versuch es später nochmal.');
  } finally { state.busy = false; }
}

/** Beim Start: läuft eine neue Version stabil, merken; alte Pakete aufräumen. */
async function settle() {
  try {
    const { path } = await WebView.getServerBasePath();
    if (/\/web\/b\d+$/.test(path || '')) await WebView.persistServerBasePath();
    const keep = (path || '').split('/').pop();
    const { files } = await Filesystem.readdir({ path: 'web', directory: Directory.Data });
    for (const f of files) {
      const n = f.name || f;
      if (n !== keep && !(JSON.parse(localStorage.getItem(PENDING) || 'null')?.path || '').endsWith('/' + n))
        await Filesystem.rmdir({ path: 'web/' + n, directory: Directory.Data, recursive: true }).catch(() => {});
    }
  } catch { /* noch kein Update installiert */ }
}

/** Direkt nach dem Laden der Daten aufrufen. true = die App startet gleich mit der neuen Version neu. */
export async function startUpdates() {
  if (!native) return false;
  try { if (await applyPending()) return true; } catch { /* dann eben mit der jetzigen Version */ }
  await settle();
  setTimeout(() => checkUpdate(), 4000);
  App.addListener('resume', async () => { try { if (await applyPending()) return; } catch { /* weiter */ } checkUpdate(); });
  return false;
}

export function initUpdateCard() {
  setInfo(native ? `Version ${BUILD}` : 'Updates gibt es nur in der App.');
  $('#up-check').hidden = !native;
  $('#up-check').onclick = () => checkUpdate({ force: true });
}
