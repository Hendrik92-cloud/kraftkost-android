import { db, save } from './store.js';
import { S, addRender, busy, lastWeight, me, familyFactor, householdText, kcalFor, kcalText, ticker, streamInfo } from './app.js';
import { $, $$, esc, de, num, uid, today, addDays, fmtDay, toast, WD, wdOf } from './util.js';
import { askJSON, aiMsg, hasKey, registerJob, pendingJob } from './claude.js';
import { showBridge } from './bridge.js';
import { logMeal } from './essen.js';
import { addShopItems, CATS, live, removeItem, guessCat, tripFor, LASTING, offersFresh, fetchOffers } from './einkauf.js';
import { sumAmounts, nameKey } from './shopmath.js';
import { scheduleTraining } from './native.js';

let sel = null, editing = null;
/** Änderung am Plan für den Familien-Abgleich vormerken. */
const touchPlan = () => { if (db.mealplan) { db.mealplan.updatedAt = Date.now(); db.mealplan.dirty = true; } };
const slotsFor = n => (n <= 3 ? ['Frühstück', 'Nachmittag', 'Abend'] : n === 4 ? ['Frühstück', 'Nachmittag', 'Abend', 'Snack'] : ['Frühstück', 'Mittag', 'Nachmittag', 'Abend', 'Snack']);

const mapMeal = m => ({
  id: uid(), slot: String(m.slot || 'Snack'), name: String(m.name || ''),
  kcal: num(m.kcal) || 0, protein: num(m.protein) || 0, carbs: num(m.kohlenhydrate) || 0, fat: num(m.fett) || 0,
  time: String(m.zeit || ''), steps: String(m.zubereitung || ''), kidTip: String(m.kind_tipp || ''),
  ingredients: (m.zutaten || []).map(z => ({ name: String(z.name || ''), amount: String(z.menge || ''), offer: String(z.laden || '') })).filter(z => z.name),
  solo: !!m.nur_ich, locked: false
});
const factorStr = f => String(f).replace('.', ',');

function offersText() {
  const O = db.offers?.items || []; if (!O.length) return '';
  return O.slice(0, 60).map(o => `${o.store}: ${o.name}${o.unit ? ' (' + o.unit + ')' : ''} ${de(o.price, 2)} €`).join('\n');
}

function renderHouse() {
  const s = db.settings; const H = s.household;
  $('#mp-house').innerHTML = `<div class="actions between"><h3>Haushalt</h3><button type="button" class="sm ghost" data-goto="einstellungen">Ändern</button></div>
    <div class="chips">${H.map(p => `<span class="chip t">${esc(p.name)} · Portion ${factorStr(p.factor)}</span>`).join('')}</div>
    <p class="small muted">Deine Portion: ${s.kcalGoal ? `Ziel ${kcalText()}` : 'Ziel schlägt Claude vor'}${s.proteinGoal ? `, ${de(s.proteinGoal)} g Eiweiß` : ''}. Einkauf für ${factorStr(Math.round(familyFactor() * 10) / 10)} Portionen.</p>`;
}

function renderTrainChips() {
  const td = db.settings.trainDays;
  $('#mp-train').innerHTML = WD.map((d, i) => `<button type="button" data-mtd="${i}" aria-pressed="${td.includes(i)}">${d}</button>`).join('');
  $$('[data-mtd]').forEach(b => b.onclick = () => {
    const i = +b.dataset.mtd; const t = db.settings.trainDays;
    db.settings.trainDays = t.includes(i) ? t.filter(x => x !== i) : t.concat(i).sort((a, c) => a - c);
    scheduleTraining(db.settings.trainDays, db.settings.trainTime, db.settings.remind).catch(() => {});
    save();
  });
}

function mealHTML(m, i) {
  const ed = editing === m.id;
  if (ed) return `<div class="meal"><div class="tag">${esc(m.slot)}</div>
    <label for="ed-name">Gericht<input id="ed-name" value="${esc(m.name)}"></label>
    <div class="row"><label for="ed-kcal">kcal<input id="ed-kcal" inputmode="decimal" value="${Math.round(m.kcal)}"></label><label for="ed-p">Eiweiß g<input id="ed-p" inputmode="decimal" value="${Math.round(m.protein)}"></label></div>
    <div class="actions"><button type="button" class="primary sm" data-edsave="${i}">Speichern</button><button type="button" class="sm ghost" data-edcancel>Abbrechen</button></div></div>`;
  return `<div class="meal ${m.locked ? 'locked' : ''}">
    <div class="actions between"><span class="tag">${esc(m.slot)}${m.locked ? ' · fixiert' : ''}</span><span class="num kcal">${de(m.kcal)} kcal</span></div>
    <div class="t">${esc(m.name)}</div>
    <div class="s">Deine Portion: E ${de(m.protein)} · K ${de(m.carbs)} · F ${de(m.fat)} g${m.time ? ' · ' + esc(m.time) : ''}</div>
    ${m.ingredients.length || m.steps ? `<details><summary>${m.solo ? 'Zutaten für dich' : 'Zutaten für alle'} und Zubereitung</summary><ul>${m.ingredients.map(z => `<li>${esc(z.amount ? z.amount + ' ' : '')}${esc(z.name)}${z.offer ? ` <span class="chip">Angebot ${esc(z.offer)}</span>` : ''}</li>`).join('')}</ul>${m.steps ? `<p class="small" style="margin-top:6px">${esc(m.steps)}</p>` : ''}${m.kidTip ? `<p class="small muted" style="margin-top:6px">Fürs Kind: ${esc(m.kidTip)}</p>` : ''}</details>` : ''}
    <div class="actions"><button type="button" class="sm primary" data-eat="${i}">✓ Gegessen</button><button type="button" class="sm" data-swap="${i}">Tauschen</button><button type="button" class="sm ghost" data-edit="${i}">Ändern</button><button type="button" class="sm ghost" data-lock="${i}" aria-label="${m.locked ? 'Fixierung lösen' : 'Für nächste Planung fixieren'}">${m.locked ? '📌 Fixiert' : '📌'}</button></div>
  </div>`;
}

function renderPlanView() {
  const P = db.mealplan; const v = $('#mp-view');
  $('#mp-sum').textContent = P ? 'Neu planen' : 'Wochenplan erstellen lassen';
  if (!P || !(P.days || []).length) {
    v.innerHTML = '<div class="empty">Noch kein Wochenplan. Unten erstellen: 7 Tage Familienessen, abgestimmt auf dein Training, mit fertiger Einkaufsliste.</div>';
    if (!renderPlanView.opened) { $('#mp-setup').open = true; renderPlanView.opened = true; }
    return;
  }
  const found = P.days.findIndex(d => d.date === today());
  const idx = Math.min(P.days.length - 1, sel ?? Math.max(0, found));
  const d = P.days[idx];
  const sum = k => d.meals.reduce((s, m) => s + (m[k] || 0), 0);
  const target = kcalFor(d.date) || P.kcalTarget;
  const past = P.days[P.days.length - 1].date < today();
  v.innerHTML = `<div class="card">
    <p class="small muted">${fmtDay(P.days[0].date)} bis ${fmtDay(P.days[P.days.length - 1].date)}${past ? ' · abgelaufen, Zeit für einen neuen Plan' : ''}</p>
    <div class="days">${P.days.map((x, i) => `<button type="button" data-mpd="${i}" class="${x.date === today() ? 'today' : ''}" aria-pressed="${i === idx}" aria-label="${fmtDay(x.date)}${x.training ? ', Trainingstag' : ''}"><small>${WD[wdOf(x.date)]}</small>${Number(x.date.slice(8))}${x.training ? '<i></i>' : '<small>&nbsp;</small>'}</button>`).join('')}</div>
    <p class="small muted">● = Trainingstag, an dem es etwas mehr Kohlenhydrate gibt.</p>
    <div class="meter"><div class="lbl2"><span>${fmtDay(d.date)} · ${d.training ? 'Trainingstag' : 'Ruhetag'}</span><span class="num">${de(sum('kcal'))}${target ? ' / ' + de(target) : ''} kcal · ${de(sum('protein'))} g E</span></div>
    <div class="bar"><div class="fill" style="width:${target ? Math.min(100, sum('kcal') / target * 100) : 0}%"></div></div></div>
  </div>
  <div class="list">${d.meals.map(mealHTML).join('')}</div>
  ${d.date >= today() && d.meals.some(m => SHIFT.has(m.slot)) ? `<div class="card"><p class="small muted">Reste übrig oder keine Lust zu kochen? Dann rutscht das Abendessen ab ${d.date === today() ? 'heute' : fmtDay(d.date)} jeweils einen Tag nach hinten, der Plan wird einen Tag länger.</p>
    <div class="actions"><button type="button" class="sm" id="mp-shift">Abendessen ab ${d.date === today() ? 'heute' : 'diesem Tag'} um einen Tag schieben</button></div></div>` : ''}
  <div class="actions"><button type="button" class="primary" id="mp-shop">Einkaufsliste erstellen</button><span class="hint" id="mp-shophint"></span></div>`;

  v.querySelectorAll('[data-mpd]').forEach(b => b.onclick = () => { sel = +b.dataset.mpd; editing = null; renderPlanView(); });
  v.querySelectorAll('[data-eat]').forEach(b => b.onclick = () => {
    const m = d.meals[+b.dataset.eat];
    logMeal({ slot: m.slot, name: m.name, kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat }, d.date <= today() ? d.date : today());
    toast(`Eingetragen für ${d.date === today() ? 'heute' : fmtDay(d.date <= today() ? d.date : today())}`);
  });
  v.querySelectorAll('[data-lock]').forEach(b => b.onclick = () => { const m = d.meals[+b.dataset.lock]; m.locked = !m.locked; touchPlan(); save(); });
  v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { editing = d.meals[+b.dataset.edit].id; renderPlanView(); });
  v.querySelectorAll('[data-edcancel]').forEach(b => b.onclick = () => { editing = null; renderPlanView(); });
  v.querySelectorAll('[data-edsave]').forEach(b => b.onclick = () => {
    const m = d.meals[+b.dataset.edsave];
    m.name = $('#ed-name').value.trim() || m.name; m.kcal = num($('#ed-kcal').value) ?? m.kcal; m.protein = num($('#ed-p').value) ?? m.protein;
    editing = null; db.mealplan.shopStale = true; touchPlan(); save(); toast('Geändert');
  });
  v.querySelectorAll('[data-swap]').forEach(b => b.onclick = () => swapMeal(d, +b.dataset.swap, b));
  $('#mp-shop').onclick = () => buildShopping(P);
  const sh = $('#mp-shift');
  if (sh) sh.onclick = () => {
    if (!sh.classList.contains('armed')) { sh.classList.add('armed'); sh.textContent = 'Wirklich schieben? Nochmal tippen'; setTimeout(() => { if (sh.isConnected) renderPlanView(); }, 4000); return; }
    shiftDinners(idx);
  };
}

/* Gekochte Mahlzeiten, die beim Verschieben mitwandern (Frühstück und Snack bleiben, die sind jeden Tag gleich). */
const SHIFT = new Set(['Abend', 'Nachtisch', 'Dessert']);

/** Abendessen ab Tag idx einen Tag nach hinten; am Ende kommt ein Tag dazu, am Tag idx bleibt das Abendessen frei (Reste/Stulle). */
function shiftDinners(idx) {
  const P = db.mealplan; const days = P.days;
  const last = days[days.length - 1];
  const extra = { date: addDays(last.date, 1), training: db.settings.trainDays.includes(wdOf(addDays(last.date, 1))),
    meals: last.meals.filter(m => !SHIFT.has(m.slot)).map(m => ({ ...m, id: uid(), locked: false })) };
  days.push(extra);
  for (let i = days.length - 1; i > idx; i--) {
    const moving = days[i - 1].meals.filter(m => SHIFT.has(m.slot));
    days[i].meals = days[i].meals.filter(m => !SHIFT.has(m.slot)).concat(moving);
  }
  days[idx].meals = days[idx].meals.filter(m => !SHIFT.has(m.slot));
  days[idx].meals.push({ id: uid(), slot: 'Abend', name: 'Reste oder Stulle', kcal: 0, protein: 0, carbs: 0, fat: 0, ingredients: [], steps: '', time: '', locked: false });
  P.shopStale = true; touchPlan(); save();
  toast(`Verschoben. Der Plan geht jetzt bis ${fmtDay(extra.date)}.`);
}

async function swapMeal(day, i, btn) {
  const m = day.meals[i];
  if (!hasKey()) { toast('Tauschen per Knopf braucht den API-Schlüssel. Ändere das Gericht über „Bearbeiten“.'); return; }
  const others = db.mealplan.days.flatMap(d => d.meals.map(x => x.name));
  await busy(btn, null, '', async () => {
    btn.textContent = 'Claude sucht …';
    try {
      const r = await askJSON(`Ersetze in einem Familien-Wochenplan diese Mahlzeit durch eine andere: ${m.slot} am ${fmtDay(day.date)} (${day.training ? 'Trainingstag' : 'Ruhetag'}), bisher "${m.name}" mit ${de(m.kcal)} kcal und ${de(m.protein)} g Eiweiß für die Portion des Erwachsenen.
Neue Mahlzeit: ähnliche Kalorien (±10 %) und Eiweiß, familien- und kindertauglich, nicht eines dieser Gerichte: ${others.join(', ')}.
Haushalt: ${householdText()}. Aufwand: ${db.mealplan.effort || 'normal'}.${db.mealplan.pref ? ' Wünsche: ' + db.mealplan.pref + '.' : ''}
Nährwerte für die Portion des Erwachsenen mit Anteil 1. Zutatenmengen für den ganzen Haushalt zusammen (${factorStr(Math.round(familyFactor() * 10) / 10)} Portionen). Mengen realistisch, Nudeln oder Reis roh etwa 70 bis 90 g pro Portion 1.
Form: {"slot":"${m.slot}","name":"…","kcal":600,"protein":40,"kohlenhydrate":60,"fett":18,"zeit":"25 min","zutaten":[{"name":"…","menge":"…"}],"zubereitung":"2 bis 3 Sätze","kind_tipp":"optional, kurz"}`, { maxTokens: 1500 });
      const nm = mapMeal(r); if (!nm.name) throw new Error();
      nm.slot = m.slot; nm.solo = m.solo; day.meals[i] = nm; db.mealplan.shopStale = true; touchPlan(); save(); toast('Getauscht: ' + nm.name);
    } catch (e) { toast(e.code ? aiMsg(e) : 'Tauschen hat nicht geklappt. Versuch es nochmal.'); }
  });
}

/* Grundvorräte, die nicht auf die Liste sollen */
const PANTRY = /^(salz|pfeffer|öl|olivenöl|rapsöl|essig|mehl|zucker|wasser|gewürze?|oregano|zimt|curry|paprikapulver|kreuzkümmel|sojasoße|brühe)$/i;

/**
 * Einkaufsliste aus dem Plan, aufgeteilt auf die Einkaufstage (Standard Mo + Do):
 * Frisches zum Einkauf vor dem Kochtag, Haltbares einmal beim ersten Einkauf. Mengen werden zusammengerechnet.
 * Eine frühere Liste aus dem Plan wird dabei ersetzt; Abgehaktes und selbst Hinzugefügtes bleibt.
 */
function buildShopping(P) {
  const from = P.days.some(d => d.date >= today()) ? today() : P.days[0].date;
  const days = P.days.filter(d => d.date >= from);
  if (!days.some(d => d.meals.some(m => m.ingredients.length))) { toast('Im Plan stehen keine Zutaten.'); return; }
  const catOf = new Map((P.shopping || []).map(x => [nameKey(x.name), x.cat]));
  // Einkäufe liegen nie in der Vergangenheit: Wer heute die Liste macht, kauft das Nächste heute ein.
  const tripOf = date => { const t = tripFor(date); return t < today() ? today() : t; };
  const first = tripOf(days[0].date);
  const groups = new Map();
  days.forEach(d => d.meals.forEach(m => m.ingredients.forEach(z => {
    if (PANTRY.test(z.name.trim())) return;
    const k = nameKey(z.name); const cat = catOf.get(k) || guessCat(z.name);
    const trip = LASTING.has(cat) ? first : tripOf(d.date);
    const g = groups.get(trip + '|' + k) || { name: z.name, cat, trip, amts: [] };
    g.amts.push(z.amount); groups.set(trip + '|' + k, g);
  })));
  // Alte Plan-Einträge (offen) ersetzen
  const planKeys = new Set([...groups.values()].map(g => nameKey(g.name)).concat((P.shopping || []).map(x => nameKey(x.name))));
  live().filter(x => !x.done && (x.src === 'plan' || (!x.src && planKeys.has(nameKey(x.name))))).forEach(removeItem);
  const items = [...groups.values()].sort((a, b) => a.trip.localeCompare(b.trip)).map(g => ({ name: g.name, amount: sumAmounts(g.amts), cat: g.cat, trip: g.trip, src: 'plan' }));
  addShopItems(items);
  const trips = [...new Set(items.map(x => x.trip))];
  const lbl = t => new Date(t + 'T12:00').toLocaleDateString('de-DE', { weekday: 'short' });
  save();
  toast(trips.length > 1 ? `Einkaufsliste erstellt: ${trips.map(t => `${lbl(t)} ${items.filter(x => x.trip === t).length}`).join(', ')} Sachen` : `${items.length} Sachen auf der Einkaufsliste`);
}

async function createPlan(e) {
  e.preventDefault();
  const s = db.settings; const td = s.trainDays; const w = lastWeight(); const ich = me();
  const meals = +$('#mp-meals').value, effort = $('#mp-effort').value, pref = $('#mp-pref').value.trim();
  const start = $('#mp-start').value || today();
  const dates = [...Array(7)].map((_, i) => addDays(start, i));
  const locked = (db.mealplan?.days || []).flatMap(d => d.meals.filter(m => m.locked).map(m => ({ ...m, date: d.date })));
  const keep = locked.filter(m => dates.includes(m.date));
  const useOffers = $('#mp-offers').checked;
  const liked = db.dishes.map(d => d.name).slice(0, 15);
  const ctx = { dates, keep, td, meals, effort, pref };
  const bridge = !hasKey();
  // Erst die Angebote, dann der Plan: Angebote dieser Woche bei Bedarf zuerst holen.
  if (useOffers && !bridge && !offersFresh()) {
    if (!db.settings.plz) toast('Für Angebote fehlt deine Postleitzahl (Zahnrad → Einstellungen). Ich plane erstmal ohne.');
    else {
      let ok = true;
      await busy($('#mp-go'), null, '', async () => {
        const tk = ticker($('#mp-hint'), 'Schritt 1 von 2: Claude sucht die Angebote von Aldi und Kaufland …');
        try { const n = await fetchOffers(); if (!n) toast('Keine Angebote gefunden, ich plane ohne.'); }
        catch (err) { ok = err.code !== 'no_key'; toast('Angebote gerade nicht abrufbar, ich plane ohne.'); }
        finally { tk.stop(); }
      });
      if (!ok) return;
    }
  }
  const offers = useOffers ? offersText() : '';
  const prompt = `Erstelle einen Familien-Essensplan für 7 Tage auf Deutsch. Alle essen dieselben Gerichte, nur die Portionen unterscheiden sich.
Haushalt: ${householdText()}.
Mahlzeiten pro Tag: ${slotsFor(meals).join(', ')}. Abends wird einmal für alle gekocht, alle essen dasselbe; keine getrennten Gerichte für einzelne Personen. Nachmittag ist eine schnelle Kleinigkeit ohne Kochen, gern auch der Rest vom Vorabend.${s.habits ? '\nFeste Gewohnheiten: ' + s.habits + ' Diese Mahlzeit jeden Tag genau so einplanen und mitzählen.' : ''}
Trainingsziel des Erwachsenen mit Portion 1: ${db.plan?.goal || 'fit und gesund bleiben'}.${w ? ` Körpergewicht ${w} kg.` : ''}
Tagesziel für diese Portion: ${s.kcalGoal ? kcalText() : 'keine Angabe. Wähle ein passendes, moderates Ziel und gib es in "ziel_kcal" an'}${s.proteinGoal ? `, ${de(s.proteinGoal)} g Eiweiß` : ', eiweißreich'}. An Trainingstagen etwas mehr Kohlenhydrate.
Tage:
${dates.map(dt => `${dt} (${WD[wdOf(dt)]}): ${td.includes(wdOf(dt)) ? 'Trainingstag' : 'Ruhetag'}`).join('\n')}
Aufwand: ${effort}. Wünsche: ${pref || 'keine'}.${liked.length ? ' Gerichte, die gut ankommen: ' + liked.join(', ') + '.' : ''}
Kindgerecht: nicht scharf, Gemüse gern versteckt oder als Rohkost dazu; bei Bedarf ein kurzer Tipp in "kind_tipp". Mag das Kind etwas nicht, isst es ein Brot; dafür keine Extra-Gerichte planen.
Reste und Vorkochen sinnvoll nutzen, damit der Einkauf klein bleibt. Wir kaufen bei Aldi und Kaufland.${offers ? '\nPlane andersherum: Schau zuerst, was diese Woche im Angebot ist, und zaubere daraus richtig leckere Gerichte. Die Hauptzutaten der Abendessen (Fleisch, Fisch, Gemüse) sollen möglichst aus den Angeboten kommen, Grundzutaten wie Reis, Nudeln oder Gewürze dürfen normal gekauft werden. Gib bei jeder Zutat aus dem Angebot "laden" an ("Aldi" oder "Kaufland").\nAngebote dieser Woche:\n' + offers : ''}${keep.length ? '\nDiese Mahlzeiten stehen fest und bleiben unverändert, plane drumherum: ' + keep.map(m => `${m.date} ${m.slot}: ${m.name}`).join('; ') : ''}
Mahlzeiten, die nur der Erwachsene mit Portion 1 isst (zum Beispiel Frühstück oder Mittag zum Mitnehmen mit Zutaten, die andere nicht mögen), bekommen "nur_ich": true. Dann gelten die Zutatenmengen nur für ihn.
Nährwerte je Mahlzeit für die Portion 1. Zutatenmengen sonst für den ganzen Haushalt (${factorStr(Math.round(familyFactor() * 10) / 10)} Portionen).
Mengen realistisch und passend zu den Kalorien rechnen, damit nichts übrig bleibt: Nudeln, Reis oder Couscous roh etwa 70 bis 90 g pro Portion 1, Kartoffeln etwa 250 g, Fleisch oder Fisch etwa 150 bis 200 g. Für den Haushalt entsprechend hochrechnen und nicht auf ganze Packungen aufrunden; wenn eine Packung angebrochen wird, den Rest in einem späteren Gericht verwenden.
${bridge ? `Fasse außerdem alle Zutaten der Woche zu einer Einkaufsliste zusammen (gleiche addieren, auf Packungsgrößen runden, ohne Salz, Pfeffer, Gewürze, Öl, Mehl, Zucker) mit Kategorie aus: ${CATS.join(', ')}.\n` : ''}Form: {"art":"wochenplan","ziel_kcal":2500,"tage":[{"datum":"YYYY-MM-DD","mahlzeiten":[{"slot":"Frühstück","name":"…","kcal":550,"protein":35,"kohlenhydrate":60,"fett":15,"zeit":"10 min","zutaten":[{"name":"Haferflocken","menge":"200 g","laden":""}],"zubereitung":"2 bis 3 Sätze","kind_tipp":""}]}]${bridge ? ',"einkauf":[{"name":"Haferflocken","menge":"1 kg","kategorie":"Brot & Trockenware"}]' : ''}}`;
  if (bridge) { showBridge($('#mp-bridge'), prompt, r => applyMealPlan(r, ctx)); return; }
  await busy($('#mp-go'), null, '', async () => {
    const tk = ticker($('#mp-hint'), 'Claude plant eure Woche …');
    try {
      let r;
      try {
        r = await askJSON(prompt, { smart: true, maxTokens: 32000, background: { kind: 'wochenplan', ctx }, onText: (t, b) => tk.set(streamInfo(b, (t.match(/"datum"\s*:/g) || []).length, 7, 'Tag')) });
      } finally { tk.stop(); }
      if (!applyMealPlan(r, ctx)) throw new Error();
    } catch (err) { $('#mp-hint').textContent = err.code ? aiMsg(err) : 'Der Plan kam unvollständig an. Versuch es nochmal.'; }
  });
}

export function applyMealPlan(r, { dates, keep, td, meals, effort, pref, noGoal: ctxNoGoal }) {
  const s = db.settings;
  const days = (r.tage || []).slice(0, 7).map((t, i) => {
    const dt = dates[i];
    const ms = (t.mahlzeiten || []).map(mapMeal).filter(m => m.name);
    keep.filter(k => k.date === dt).forEach(k => {
      const j = ms.findIndex(m => m.slot === k.slot); const { date, ...meal } = k;
      if (j >= 0) ms[j] = meal; else ms.push(meal);
    });
    // Trainingstag erst ab Start des Trainingsplans
    return { date: dt, training: td.includes(wdOf(dt)) && (!db.plan?.start || dt >= db.plan.start), meals: ms };
  }).filter(t => t.meals.length);
  if (!days.length) return false;
  const shopping = (r.einkauf || []).map(x => ({ name: String(x.name || ''), amount: String(x.menge || ''), cat: CATS.includes(x.kategorie) ? x.kategorie : 'Sonstiges' })).filter(x => x.name);
  db.mealplan = { days, shopping, kcalTarget: num(r.ziel_kcal) || s.kcalGoal || null, mealsPerDay: meals, effort, pref, createdAt: Date.now() };
  if (!s.kcalGoal && db.mealplan.kcalTarget && !ctxNoGoal) s.kcalGoal = db.mealplan.kcalTarget;
  touchPlan();
  sel = null; editing = null; $('#mp-setup').open = false; $('#mp-hint').textContent = '';
  save(); toast('Wochenplan gespeichert');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

export function initPlan() {
  $('#mp-start').value = today();
  $('#mpform').onsubmit = createPlan;
  addRender(() => { renderHouse(); renderTrainChips(); renderPlanView(); jobHint(); });
  registerJob('wochenplan', (r, ctx) => applyMealPlan(r, ctx));
}
const BG = 'Claude macht euren Plan im Hintergrund fertig. Die App übernimmt ihn von selbst.';
function jobHint() {
  const h = $('#mp-hint');
  if (pendingJob('wochenplan')) { if (!$('#mp-go').disabled) h.textContent = BG; }
  else if (h.textContent === BG) h.textContent = '';
}
