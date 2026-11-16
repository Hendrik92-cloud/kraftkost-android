/* Übernimmt, was im Claude-Chat erstellt wurde: Trainingsplan, Wochenplan, Einstellungen oder ein Paket aus allem. */
import { db, save } from './store.js';
import { $, num, uid, today, addDays, toast, WD } from './util.js';
import { extractJSON, paste } from './bridge.js';
import { applyPlan } from './training.js';
import { applyMealPlan } from './plan.js';
import { scheduleTraining } from './native.js';
import { applySupps } from './supps.js';
import { syncNow } from './sync.js';

function applySettings(e) {
  if (!e) return [];
  const s = db.settings; const done = [];
  const kg = num(e.gewicht);
  if (kg) {
    const ex = db.weights.find(w => w.date === today());
    if (ex) ex.kg = kg; else db.weights.push({ id: uid(), date: today(), kg });
    done.push('Gewicht');
  }
  if (num(e.kcal)) { s.kcalGoal = num(e.kcal); done.push('Kalorienziel'); }
  if (num(e.kcal_wochenende)) { s.kcalWeekend = num(e.kcal_wochenende); }
  // Vorlieben im Haushalt: {"ich": {"mag": "…"}, "frau": {"mag_nicht": "…"}}
  if (e.vorlieben) for (const [id, v] of Object.entries(e.vorlieben)) {
    const p = s.household.find(x => x.id === id); if (!p) continue;
    if (v.mag) p.likes = v.mag; if (v.mag_nicht) p.dislikes = v.mag_nicht;
    if (!done.includes('Vorlieben')) done.push('Vorlieben');
  }
  if (num(e.eiweiss)) { s.proteinGoal = num(e.eiweiss); done.push('Eiweißziel'); }
  if (Array.isArray(e.trainingstage) && e.trainingstage.length) {
    const days = e.trainingstage.map(d => WD.indexOf(String(d).slice(0, 2))).filter(i => i >= 0).sort((a, b) => a - b);
    if (days.length) { s.trainDays = days; done.push('Trainingstage'); }
  }
  if (/^\d{1,2}:\d{2}$/.test(e.uhrzeit || '')) { s.trainTime = e.uhrzeit.padStart(5, '0'); done.push('Uhrzeit'); }
  if (e.gewohnheiten) { s.habits = String(e.gewohnheiten); done.push('Gewohnheiten'); }
  scheduleTraining(s.trainDays, s.trainTime, s.remind).catch(() => {});
  return done;
}

/** Gerichte für „Schnell eintragen“ merken. */
function applyDishes(list) {
  let n = 0;
  for (const d of list || []) {
    if (!d.name || db.dishes.some(x => x.name.toLowerCase() === d.name.toLowerCase())) continue;
    db.dishes.push({ id: uid(), name: d.name, kcal: num(d.kcal), protein: num(d.protein) || 0, carbs: num(d.kohlenhydrate) || 0, fat: num(d.fett) || 0, parts: [] });
    n++;
  }
  return n;
}
/** Einträge einer älteren, ersetzten Einkaufsliste entfernen (nur offene, mit gleichem Namen und gleicher Menge). */
function removeOldShopping(list) {
  const key = x => (x.name + '|' + (x.menge ?? x.amount ?? '')).toLowerCase();
  const old = new Set((list || []).map(key));
  const before = db.shop.filter(x => !x.deleted).length;
  db.shop.forEach(x => { if (!x.done && !x.deleted && old.has(key(x))) { x.deleted = true; x.dirty = true; x.updated = Date.now(); } });
  if (!db.settings.sync) db.shop = db.shop.filter(x => !x.deleted);
  return before - db.shop.filter(x => !x.deleted).length;
}

const metaFrom = t => ({
  goal: t.ziel || 'Abnehmen und straffen', level: t.erfahrung || '', time: t.zeit || '60 min',
  notes: t.notizen || '', start: /^\d{4}-\d{2}-\d{2}$/.test(t.start || '') ? t.start : today()
});
const isTraining = j => j.art === 'trainingsplan' || (Array.isArray(j.tage) && j.tage[0]?.uebungen);
const isMeal = j => j.art === 'wochenplan' || (Array.isArray(j.tage) && j.tage[0]?.mahlzeiten);
function mealCtx(j) {
  const first = /^\d{4}-\d{2}-\d{2}$/.test(j.tage?.[0]?.datum || '') ? j.tage[0].datum : today();
  return { dates: [...Array(7)].map((_, i) => addDays(first, i)), keep: [], td: db.settings.trainDays, meals: Math.max(...j.tage.map(t => (t.mahlzeiten || []).length), 3), effort: '', pref: '', noGoal: true };
}

/** Gibt eine Beschreibung des Übernommenen zurück oder null. */
export function importAny(j) {
  if (!j || typeof j !== 'object') return null;
  const parts = [];
  if (j.art === 'paket') {
    parts.push(...applySettings(j.einstellungen));
    if (applyDishes(j.gerichte)) parts.push('Gerichte');
    if (j.ergaenzungen && applySupps(j.ergaenzungen)) parts.push('Ergänzungen');
    if (j.einkauf_entfernen) removeOldShopping(j.einkauf_entfernen);
    if (j.firmen) {
      const C = db.settings.companies; let n = 0;
      for (const f of j.firmen) { if (!f.name || C.some(c => c.name.toLowerCase() === f.name.toLowerCase())) continue; C.push({ id: uid(), name: f.name, email: f.email || '' }); n++; }
      if (n) parts.push('Firmen');
    }
    if (j.sync?.url && j.sync?.key && j.sync?.household) {
      // Eigene Einträge mit hochladen; ein vorhandener gemeinsamer Plan geht vor, wenn hier keiner neu übernommen wurde.
      db.settings.sync = { url: j.sync.url, key: j.sync.key, household: j.sync.household };
      db.shop.forEach(x => { x.dirty = true; x.updated = x.updated || Date.now(); });
      if (db.mealplan && !db.mealplan.dirty) db.mealplan.updatedAt = 0;
      parts.push('Familien-Abgleich');
      setTimeout(() => syncNow(), 300);
    }
    if (j.trainingsplan && applyPlan(j.trainingsplan, metaFrom(j.trainingsplan))) parts.push('Trainingsplan');
    if (j.wochenplan && applyMealPlan(j.wochenplan, mealCtx(j.wochenplan))) parts.push('Wochenplan');
  } else if (isTraining(j)) { if (applyPlan(j, metaFrom(j))) parts.push('Trainingsplan'); }
  else if (isMeal(j)) { if (applyMealPlan(j, mealCtx(j))) parts.push('Wochenplan'); }
  else if (j.einstellungen) parts.push(...applySettings(j.einstellungen));
  if (!parts.length) return null;
  save();
  return parts.join(', ');
}

export async function importFromText(text, hintEl) {
  const j = extractJSON(text);
  if (!j) { hintEl.textContent = text.trim() ? 'Darin steckt kein gültiger Block. Kopier den ganzen Codeblock aus dem Chat.' : 'Die Zwischenablage ist leer. Kopier zuerst den Codeblock aus dem Chat.'; return false; }
  const what = importAny(j);
  if (!what) { hintEl.textContent = 'Den Inhalt kenne ich nicht. Ist es der Block aus dem Claude-Chat?'; return false; }
  hintEl.textContent = 'Übernommen: ' + what + '.'; toast('Übernommen: ' + what);
  return true;
}

export function initImporter() {
  document.querySelectorAll('[data-import]').forEach(b => b.onclick = async () => {
    const hint = document.getElementById(b.dataset.import);
    await importFromText(await paste(), hint);
  });
  $('#imp-use').onclick = () => importFromText($('#imp-area').value, $('#imp-hint')).then(ok => { if (ok) $('#imp-area').value = ''; });
}
