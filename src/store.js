import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

const isNative = Capacitor.isNativePlatform();
const FILE = 'kraftkost/data.json';
const IMG = id => `kraftkost/img/${id}.jpg`;

export const defaults = () => ({
  v: 1,
  workouts: [], meals: [], weights: [], receipts: [], dishes: [], shop: [],
  plan: null, mealplan: null, offers: null,
  settings: {
    kcalGoal: null, proteinGoal: null,
    trainDays: [0, 2, 4], trainTime: '18:00', trainMinutes: 60, remind: false, warrantyRemind: true,
    plz: '', apiKey: '',
    modelQuick: 'claude-haiku-5-5', modelSmart: 'claude-sonnet-5-5',
    household: [
      { id: 'ich', name: 'Ich', kind: 'adult', factor: 1, likes: '', dislikes: '' },
      { id: 'frau', name: 'Frau', kind: 'adult', factor: 0.8, likes: '', dislikes: '' },
      { id: 'sohn', name: 'Sohn', kind: 'child', age: 5, factor: 0.5, likes: 'Champignons', dislikes: '' }
    ]
  }
});

export const db = defaults();
const listeners = [];
export const onChange = fn => listeners.push(fn);

function apply(d) {
  const def = defaults();
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, def, d || {});
  db.settings = { ...def.settings, ...((d && d.settings) || {}) };
}

export async function load() {
  try {
    let txt = null;
    if (isNative) {
      const r = await Filesystem.readFile({ path: FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
      txt = r.data;
    } else txt = localStorage.getItem('kraftkost');
    if (txt) apply(JSON.parse(txt));
  } catch { /* erster Start: noch keine Datei */ }
}

let timer;
/** Nach jeder Änderung aufrufen: rendert neu und speichert kurz danach. */
export function save() {
  listeners.forEach(f => f());
  clearTimeout(timer); timer = setTimeout(flush, 250);
}

export async function flush() {
  clearTimeout(timer);
  const txt = JSON.stringify(db);
  try {
    if (isNative) await Filesystem.writeFile({ path: FILE, data: txt, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
    else localStorage.setItem('kraftkost', txt);
  } catch (e) { console.error('Speichern fehlgeschlagen', e); }
}

export function replaceAll(d) { apply(d); save(); }

/* ---------- Bilder (Belege) ---------- */
const webImgs = new Map();
export async function saveImage(id, b64) {
  if (isNative) await Filesystem.writeFile({ path: IMG(id), data: b64, directory: Directory.Data, recursive: true });
  else { webImgs.set(id, b64); try { localStorage.setItem('img_' + id, b64); } catch { /* Speicher voll */ } }
}
export async function readImage(id) {
  try {
    if (isNative) return (await Filesystem.readFile({ path: IMG(id), directory: Directory.Data })).data;
    return webImgs.get(id) || localStorage.getItem('img_' + id) || '';
  } catch { return ''; }
}
export async function deleteImage(id) {
  try {
    if (isNative) await Filesystem.deleteFile({ path: IMG(id), directory: Directory.Data });
    else { webImgs.delete(id); localStorage.removeItem('img_' + id); }
  } catch { /* schon weg */ }
}
