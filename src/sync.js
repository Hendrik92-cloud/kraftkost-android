/* Abgleich von Einkaufsliste und Wochenplan zwischen Familienmitgliedern über Supabase (REST, ohne Konto). */
import { db, save, onChange } from './store.js';

const cfg = () => db.settings.sync || null;
export const connected = () => !!(cfg()?.url && cfg()?.key && cfg()?.household);
let status = { state: 'off', at: null, msg: '' };
const statusListeners = [];
export const onStatus = f => statusListeners.push(f);
export const getStatus = () => status;
function setStatus(s) { status = { ...status, ...s }; statusListeners.forEach(f => f(status)); }

export class SyncError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function headers(c, extra = {}) {
  const h = { apikey: c.key, 'x-household': c.household, 'content-type': 'application/json', ...extra };
  if (!c.key.startsWith('sb_')) h.Authorization = 'Bearer ' + c.key; // alte anon-Schlüssel sind JWTs
  return h;
}
async function rest(c, path, opts = {}) {
  let res;
  try { res = await fetch(c.url.replace(/\/+$/, '') + '/rest/v1/' + path, { ...opts, headers: headers(c, opts.headers) }); }
  catch { throw new SyncError('network', 'Keine Verbindung. Abgleich folgt, sobald du wieder online bist.'); }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (res.status === 404 || /does not exist|kk_items|kk_docs/.test(t) && /relation|schema/.test(t)) throw new SyncError('setup', 'Die Tabellen fehlen. Führ das Setup-Skript in Supabase aus.');
    if (res.status === 401 || /api ?key/i.test(t)) throw new SyncError('auth', 'Projekt-URL oder Schlüssel stimmt nicht.');
    throw new SyncError('api', 'Supabase meldet einen Fehler (' + res.status + ').');
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/* ---------- Senden ---------- */
let pushing = false;
export async function push() {
  if (!connected() || pushing) return;
  const c = cfg();
  const items = db.shop.filter(x => x.dirty);
  const plan = db.mealplan?.dirty ? db.mealplan : null;
  if (!items.length && !plan) return;
  pushing = true;
  try {
    if (items.length) {
      await rest(c, 'kk_items?on_conflict=id', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(items.map(x => ({ id: x.id, household: c.household, name: x.name, amount: x.amount || '', cat: x.cat || 'Sonstiges', done: !!x.done, deleted: !!x.deleted, updated_at: x.updated || Date.now() })))
      });
      items.forEach(x => { delete x.dirty; });
    }
    if (plan) {
      const { dirty, ...data } = plan;
      await rest(c, 'kk_docs?on_conflict=household,kind', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ household: c.household, kind: 'mealplan', data, updated_at: plan.updatedAt || Date.now() }])
      });
      delete plan.dirty;
    }
    db.shop = db.shop.filter(x => !(x.deleted && !x.dirty));
    setStatus({ state: 'ok', at: new Date(), msg: '' });
    save();
  } catch (e) { setStatus({ state: 'error', msg: e.message }); }
  finally { pushing = false; }
}

/* ---------- Holen ---------- */
let pulling = false;
export async function pull() {
  if (!connected() || pulling) return;
  pulling = true;
  const c = cfg();
  try {
    const [rows, docs] = await Promise.all([
      rest(c, `kk_items?household=eq.${encodeURIComponent(c.household)}&select=*`),
      rest(c, `kk_docs?household=eq.${encodeURIComponent(c.household)}&kind=eq.mealplan&select=*`)
    ]);
    let changed = false;
    for (const r of rows || []) {
      const l = db.shop.find(x => x.id === r.id);
      if (!l) {
        if (!r.deleted) { db.shop.push({ id: r.id, name: r.name, amount: r.amount, cat: r.cat, done: r.done, updated: r.updated_at }); changed = true; }
      } else if (!l.dirty && r.updated_at > (l.updated || 0)) {
        if (r.deleted) db.shop = db.shop.filter(x => x.id !== r.id);
        else Object.assign(l, { name: r.name, amount: r.amount, cat: r.cat, done: r.done, updated: r.updated_at });
        changed = true;
      }
    }
    // Lokal vorhanden, aber auf dem Server endgültig gelöscht: entfernen (nur bereits abgeglichene Einträge)
    const ids = new Set((rows || []).map(r => r.id));
    const before = db.shop.length;
    db.shop = db.shop.filter(x => x.dirty || ids.has(x.id) || !x.synced);
    if (db.shop.length !== before) changed = true;
    db.shop.forEach(x => { if (ids.has(x.id)) x.synced = true; });

    const d = docs?.[0];
    if (d?.data && !db.mealplan?.dirty && d.updated_at > (db.mealplan?.updatedAt || 0)) {
      db.mealplan = { ...d.data, updatedAt: d.updated_at };
      changed = true;
    }
    setStatus({ state: 'ok', at: new Date(), msg: '' });
    if (changed) save();
    // Alte gelöschte Einträge auf dem Server aufräumen
    if (Math.random() < 0.1) rest(c, `kk_items?household=eq.${encodeURIComponent(c.household)}&deleted=eq.true&updated_at=lt.${Date.now() - 14 * 864e5}`, { method: 'DELETE' }).catch(() => {});
  } catch (e) { setStatus({ state: 'error', msg: e.message }); }
  finally { pulling = false; }
}

export async function syncNow() { await push(); await pull(); await push(); }

/* ---------- Einrichten ---------- */
const randomCode = () => { const a = new Uint8Array(24); crypto.getRandomValues(a); return Array.from(a, b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join(''); };
export async function testConnection(c) { await rest(c, `kk_items?household=eq.${encodeURIComponent(c.household)}&select=id&limit=1`); }

export async function createHousehold(url, key) {
  url = url.trim().replace(/\/+$/, ''); key = key.trim();
  if (!/^(https:\/\/.+|http:\/\/localhost)/.test(url)) throw new SyncError('input', 'Die Projekt-URL beginnt mit https://');
  const c = { url, key, household: randomCode() };
  await testConnection(c);
  db.settings.sync = c;
  db.shop.forEach(x => { x.dirty = true; x.updated = x.updated || Date.now(); });
  if (db.mealplan) { db.mealplan.dirty = true; db.mealplan.updatedAt = db.mealplan.updatedAt || Date.now(); }
  save(); await syncNow(); failIfError();
}
function failIfError() { if (status.state === 'error') throw new SyncError('api', 'Verbunden, aber Speichern klappt nicht: ' + status.msg + ' Ist das Setup-Skript ausgeführt?'); }

export const inviteCode = () => { const c = cfg(); return 'KK1:' + btoa(JSON.stringify({ u: c.url, k: c.key, h: c.household })); };

export async function joinHousehold(text) {
  const m = String(text).match(/KK1:([A-Za-z0-9+/=]+)/);
  if (!m) throw new SyncError('input', 'Das ist kein Kraftkost-Einladungscode. Er beginnt mit „KK1:“.');
  let o; try { o = JSON.parse(atob(m[1])); } catch { throw new SyncError('input', 'Der Code ist unvollständig. Lass ihn dir nochmal schicken.'); }
  const c = { url: o.u, key: o.k, household: o.h };
  await testConnection(c);
  db.settings.sync = c;
  // Eigene Einträge behalten und mit hochladen; der gemeinsame Plan ersetzt den eigenen.
  db.shop.forEach(x => { x.dirty = true; x.updated = x.updated || Date.now(); });
  if (db.mealplan) db.mealplan.updatedAt = 0;
  save(); await syncNow(); failIfError();
}

export function disconnect() { db.settings.sync = null; setStatus({ state: 'off', at: null, msg: '' }); save(); }

/* ---------- Automatik ---------- */
let pushT, timer;
export function startSync(isFrequent) {
  onChange(() => { if (!connected()) return; clearTimeout(pushT); pushT = setTimeout(push, 800); });
  const tick = () => { if (connected() && document.visibilityState !== 'hidden') pull(); clearTimeout(timer); timer = setTimeout(tick, isFrequent() ? 15000 : 60000); };
  tick();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
}
