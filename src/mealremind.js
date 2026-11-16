/**
 * Erinnerung ans Eintragen der Mahlzeiten. Geplant werden die nächsten 7 Tage als einzelne
 * Benachrichtigungen. Was heute schon eingetragen ist, wird nicht mehr angemahnt: Nach jedem
 * Eintrag plant die App neu.
 */
import { db, save } from './store.js';
import { addRender } from './app.js';
import { $, today, addDays, toast } from './util.js';
import { scheduleMeals } from './native.js';

const SLOTS = ['Frühstück', 'Nachmittag', 'Abend'];
const COUNTS = { 'Frühstück': ['Frühstück'], 'Nachmittag': ['Mittag', 'Nachmittag', 'Snack'], 'Abend': ['Abend'] };
const s = () => db.settings;
let lastSig = '', timer = null;

function planned(date, slot) {
  const d = (db.mealplan?.days || []).find(x => x.date === date);
  return d?.meals.find(m => m.slot === slot)?.name || '';
}

function items() {
  if (!s().mealRemind) return [];
  const out = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(today(), i);
    SLOTS.forEach((slot, k) => {
      if (db.meals.some(m => m.date === date && COUNTS[slot].includes(m.slot))) return;
      const [h, mi] = (s().mealTimes?.[slot] || '12:00').split(':').map(Number);
      const at = new Date(date + 'T00:00'); at.setHours(h, mi, 0, 0);
      const name = planned(date, slot);
      out.push({
        id: 300 + i * 3 + k, at,
        title: `${slot}: schon eingetragen?`,
        body: name ? `Laut Plan: ${name}. Ein Tipp auf „Gegessen“ trägt es ein.` : 'Kurz eintragen, damit deine Kalorien stimmen.'
      });
    });
  }
  return out;
}

export function rescheduleMeals(ask = false) {
  return scheduleMeals(items(), ask);
}

/** Nach Änderungen (Eintrag, Plan, Einstellungen) neu planen, aber nicht bei jedem Render. */
function maybe() {
  const sig = JSON.stringify([today(), s().mealRemind, s().mealTimes, db.meals.filter(m => m.date >= today()).map(m => m.date + m.slot), db.mealplan?.updatedAt]);
  if (sig === lastSig) return;
  lastSig = sig; clearTimeout(timer);
  timer = setTimeout(() => rescheduleMeals().catch(() => {}), 1200);
}

export function initMealRemind() {
  const t = () => s().mealTimes;
  const draw = () => {
    SLOTS.forEach((slot, k) => { const el = $('#mr-t' + k); if (document.activeElement !== el) el.value = t()[slot]; });
    $('#mr-on').checked = s().mealRemind;
    $('#mr-hint').textContent = s().mealRemind ? `Erinnert um ${SLOTS.map(x => t()[x]).join(', ')} Uhr, nur wenn noch nichts eingetragen ist.` : '';
  };
  SLOTS.forEach((slot, k) => $('#mr-t' + k).onchange = e => { s().mealTimes = { ...t(), [slot]: e.target.value || t()[slot] }; save(); draw(); maybe(); });
  $('#mr-on').onchange = async () => {
    s().mealRemind = $('#mr-on').checked; save(); draw(); lastSig = '';
    try { await rescheduleMeals(true); } catch (e) { toast(e.message); }
  };
  addRender(() => { draw(); maybe(); });
}
