import { db } from './store.js';
import { today } from './util.js';

/** Zustand der Oberfläche, der nicht gespeichert wird. */
export const S = { day: today(), tab: 'training', more: 'gewicht' };

const renders = [];
export const addRender = f => renders.push(f);
export const renderAll = () => renders.forEach(f => { try { f(); } catch (e) { console.error(e); } });

/** Knopf sperren, Hinweis zeigen, Aufgabe ausführen. */
export async function busy(btn, hintEl, msg, fn) {
  if (btn) btn.disabled = true;
  if (hintEl && msg) hintEl.textContent = msg;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

export const lastWeight = () => {
  const k = [...db.weights].sort((a, b) => a.date.localeCompare(b.date));
  return k.length ? k[k.length - 1].kg : null;
};

/** Kalorienziel für einen Tag: am Wochenende das eigene Wochenendziel, falls gesetzt. */
/** Grundziel des Tages (Wochenende mehr), ohne Sport. */
export const kcalBase = date => {
  const s = db.settings; const wd = new Date(date + 'T12:00').getDay();
  return (wd === 0 || wd === 6) && s.kcalWeekend ? s.kcalWeekend : s.kcalGoal;
};
/** Die Hälfte der Sport-Kalorien von der Uhr darf zusätzlich gegessen werden (Uhren schätzen eher zu hoch). */
export const sportBonus = date => Math.round((Number(db.activity?.[date]?.kcal) || 0) / 2);
export const kcalFor = date => { const b = kcalBase(date); return b ? b + sportBonus(date) : b; };
export const kcalText = () => {
  const s = db.settings;
  if (!s.kcalGoal) return '';
  return s.kcalWeekend ? `Mo–Fr ${s.kcalGoal.toLocaleString('de-DE')} kcal, Sa/So ${s.kcalWeekend.toLocaleString('de-DE')} kcal` : `${s.kcalGoal.toLocaleString('de-DE')} kcal`;
};

export const me = () => db.settings.household.find(p => p.id === 'ich') || db.settings.household[0];
export const familyFactor = () => db.settings.household.reduce((s, p) => s + (Number(p.factor) || 0), 0) || 1;
export const householdText = () => db.settings.household.map(p => {
  const bits = [`${p.name}${p.kind === 'child' ? ` (Kind${p.age ? ', ' + p.age + ' Jahre' : ''})` : ''}: Portion ${String(p.factor).replace('.', ',')}`];
  if (p.likes) bits.push('mag ' + p.likes);
  if (p.dislikes) bits.push('mag nicht ' + p.dislikes);
  return bits.join(', ');
}).join('; ');

export const defaultTrainDays = n => ({ 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] })[n] || [0, 2, 4];

/** Laufende Anzeige mit Sekunden, damit man sieht, dass noch etwas passiert. */
export function ticker(el, base) {
  const t0 = Date.now(); let extra = '';
  const draw = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    el.textContent = `${base} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${extra ? ' · ' + extra : ''}`;
  };
  draw(); const iv = setInterval(draw, 1000);
  return { set(x) { extra = x; draw(); }, stop() { clearInterval(iv); } };
}
/** Fortschrittstext aus der laufenden Claude-Antwort. */
export const streamInfo = (bytes, done, total, unit) =>
  done ? `${total ? `${unit} ${Math.min(done, total)} von ${total}` : `${done} ${unit}`} · ${Math.max(1, Math.round(bytes / 1024))} KB`
    : bytes ? `${Math.max(1, Math.round(bytes / 1024))} KB empfangen` : 'warte auf Antwort';
