/**
 * Schritte und Sport-Kalorien automatisch von der Uhr.
 * Weg: Huawei Health → Health Sync → Health Connect (Android) → Kraftkost.
 * Von Hand eingetragene Tage werden nicht überschrieben.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Health } from '@capgo/capacitor-health';
import { db, save } from './store.js';
import { renderAll } from './app.js';
import { today, addDays } from './util.js';

const native = Capacitor.isNativePlatform();
const TYPES = ['steps', 'calories'];
let busy = false;

/** Pro Quelle aufsummieren und die größte nehmen, damit Handy und Uhr nicht doppelt zählen. */
function total(samples) {
  const by = {};
  for (const x of samples || []) { const k = x.sourceId || x.sourceName || '?'; by[k] = (by[k] || 0) + (Number(x.value) || 0); }
  return Math.round(Math.max(0, ...Object.values(by)));
}

async function readDay(date) {
  const start = new Date(date + 'T00:00:00'), end = new Date(start); end.setDate(end.getDate() + 1);
  const q = t => Health.readSamples({ dataType: t, startDate: start.toISOString(), endDate: (end > new Date() ? new Date() : end).toISOString(), limit: 0 });
  const [st, kc] = await Promise.all([q('steps'), q('calories')]);
  return { steps: total(st.samples), kcal: total(kc.samples) };
}

/** Verbinden: fragt einmal nach der Erlaubnis. Gibt eine Meldung für die Anzeige zurück. */
export async function connectHealth() {
  if (!native) return 'Das geht nur in der App auf dem Handy.';
  const av = await Health.isAvailable().catch(() => ({ available: false }));
  if (!av.available) return 'Health Connect fehlt auf dem Handy. Installier „Health Connect“ aus dem Play Store und versuch es nochmal.';
  const st = await Health.requestAuthorization({ read: TYPES, write: [] });
  if (!TYPES.every(t => st.readAuthorized?.includes(t))) return 'Kraftkost hat keine Erlaubnis bekommen. Tipp nochmal auf „Verbinden“ und erlaube Schritte und aktive Kalorien.';
  db.settings.healthSync = true; save();
  await syncHealth();
  return '';
}

export async function syncHealth() {
  if (!native || !db.settings.healthSync || busy) return;
  busy = true;
  try {
    const st = await Health.checkAuthorization({ read: TYPES, write: [] });
    if (!TYPES.some(t => st.readAuthorized?.includes(t))) return;
    db.activity = db.activity || {};
    let changed = false;
    for (const date of [addDays(today(), -1), today()]) {
      const cur = db.activity[date];
      if (cur?.src === 'hand') continue;
      const v = await readDay(date);
      if (!v.steps && !v.kcal) continue;
      if (cur?.kcal !== v.kcal || cur?.steps !== v.steps) { db.activity[date] = { ...v, src: 'uhr' }; changed = true; }
    }
    db.settings.healthAt = Date.now();
    save(); if (changed) renderAll();
  } catch { /* nächstes Mal */ }
  finally { busy = false; }
}

export function startHealth() {
  if (!native) return;
  setTimeout(syncHealth, 2500);
  App.addListener('resume', () => syncHealth());
  setInterval(syncHealth, 10 * 60 * 1000);
}
