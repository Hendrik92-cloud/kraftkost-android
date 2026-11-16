import { db, save } from './store.js';
import { S, addRender, busy, lastWeight, me, familyFactor, householdText } from './app.js';
import { $, $$, esc, de, num, uid, today, addDays, fmtDay, toast, WD, wdOf } from './util.js';
import { askJSON, aiMsg, hasKey } from './claude.js';
import { showBridge } from './bridge.js';
import { logMeal } from './essen.js';
import { addShopItems, CATS } from './einkauf.js';
import { scheduleTraining } from './native.js';

let sel = null, editing = null;
/** Änderung am Plan für den Familien-Abgleich vormerken. */
const touchPlan = () => { if (db.mealplan) { db.mealplan.updatedAt = Date.now(); db.mealplan.dirty = true; } };
const slotsFor = n => ['Frühstück', 'Mittag', 'Abend', 'Snack', 'Snack'].slice(0, n);

const mapMeal = m => ({
  id: uid(), slot: String(m.slot || 'Snack'), name: String(m.name || ''),
  kcal: num(m.kcal) || 0, protein: num(m.protein) || 0, carbs: num(m.kohlenhydrate) || 0, fat: num(m.fett) || 0,
  time: String(m.zeit || ''), steps: String(m.zubereitung || ''), kidTip: String(m.kind_tipp || ''),
  ingredients: (m.zutaten || []).map(z => ({ name: String(z.name || ''), amount: String(z.menge || '') })).filter(z => z.name),
  locked: false
});
const factorStr = f => String(f).replace('.', ',');

function offersText() {
  const O = db.offers?.items || []; if (!O.length) return '';
  return O.slice(0, 80).map(o => `${o.store}: ${o.name}${o.unit ? ' (' + o.unit + ')' : ''} ${de(o.price, 2)} €`).join('\n');
}

function renderHouse() {
  const s = db.settings; const H = s.household;
  $('#mp-house').innerHTML = `<div class="actions between"><h3>Haushalt</h3><button type="button" class="sm ghost" data-goto="einstellungen">Ändern</button></div>
    <div class="chips">${H.map(p => `<span class="chip t">${esc(p.name)} · Portion ${factorStr(p.factor)}</span>`).join('')}</div>
    <p class="small muted">Deine Portion: ${s.kcalGoal ? `Ziel ${de(s.kcalGoal)} kcal` : 'Ziel schlägt Claude vor'}${s.proteinGoal ? `, ${de(s.proteinGoal)} g Eiweiß` : ''}. Einkauf für ${factorStr(Math.round(familyFactor() * 10) / 10)} Portionen.</p>`;
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
    ${m.ingredients.length || m.steps ? `<details><summary>Zutaten für alle und Zubereitung</summary><ul>${m.ingredients.map(z => `<li>${esc(z.amount ? z.amount + ' ' : '')}${esc(z.name)}</li>`).join('')}</ul>${m.steps ? `<p class="small" style="margin-top:6px">${esc(m.steps)}</p>` : ''}${m.kidTip ? `<p class="small muted" style="margin-top:6px">Fürs Kind: ${esc(m.kidTip)}</p>` : ''}</details>` : ''}
    <div class="actions"><button type="button" class="sm" data-eat="${i}">Gegessen</button><button type="button" class="sm" data-swap="${i}">Tauschen</button><button type="button" class="sm ghost" data-edit="${i}">Bearbeiten</button><button type="button" class="sm ghost" data-lock="${i}">${m.locked ? 'Lösen' : 'Fixieren'}</button></div>
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
  const target = db.settings.kcalGoal || P.kcalTarget;
  const past = P.days[P.days.length - 1].date < today();
  v.innerHTML = `<div class="card">
    <p class="small muted">${fmtDay(P.days[0].date)} bis ${fmtDay(P.days[P.days.length - 1].date)}${past ? ' · abgelaufen, Zeit für einen neuen Plan' : ''}</p>
    <div class="filter">${P.days.map((x, i) => `<button type="button" data-mpd="${i}" aria-pressed="${i === idx}" aria-label="${fmtDay(x.date)}${x.training ? ', Trainingstag' : ''}">${WD[wdOf(x.date)]}${x.training ? ' ●' : ''}</button>`).join('')}</div>
    <div class="meter"><div class="lbl2"><span>${fmtDay(d.date)} · ${d.training ? 'Trainingstag' : 'Ruhetag'}</span><span class="num">${de(sum('kcal'))}${target ? ' / ' + de(target) : ''} kcal · ${de(sum('protein'))} g E</span></div>
    <div class="bar"><div class="fill" style="width:${target ? Math.min(100, sum('kcal') / target * 100) : 0}%"></div></div></div>
  </div>
  <div class="list">${d.meals.map(mealHTML).join('')}</div>
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
    editing = null; touchPlan(); save(); toast('Geändert');
  });
  v.querySelectorAll('[data-swap]').forEach(b => b.onclick = () => swapMeal(d, +b.dataset.swap, b));
  $('#mp-shop').onclick = () => buildShopping(P);
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
Nährwerte für die Portion des Erwachsenen mit Anteil 1. Zutatenmengen für den ganzen Haushalt zusammen (${factorStr(Math.round(familyFactor() * 10) / 10)} Portionen).
Form: {"slot":"${m.slot}","name":"…","kcal":600,"protein":40,"kohlenhydrate":60,"fett":18,"zeit":"25 min","zutaten":[{"name":"…","menge":"…"}],"zubereitung":"2 bis 3 Sätze","kind_tipp":"optional, kurz"}`, { maxTokens: 1500 });
      const nm = mapMeal(r); if (!nm.name) throw new Error();
      nm.slot = m.slot; day.meals[i] = nm; touchPlan(); save(); toast('Getauscht: ' + nm.name);
    } catch (e) { toast(e.code ? aiMsg(e) : 'Tauschen hat nicht geklappt. Versuch es nochmal.'); }
  });
}

function localMerge(lines) {
  const map = new Map();
  lines.forEach(z => { const k = z.name.toLowerCase().trim(); const e = map.get(k); if (e) { if (z.amount) e.amount = e.amount ? e.amount + ' + ' + z.amount : z.amount; } else map.set(k, { name: z.name, amount: z.amount, cat: 'Sonstiges' }); });
  return [...map.values()];
}
async function buildShopping(P) {
  const from = P.days.some(d => d.date >= today()) ? today() : P.days[0].date;
  const lines = P.days.filter(d => d.date >= from).flatMap(d => d.meals.flatMap(m => m.ingredients));
  if (!lines.length) { toast('Im Plan stehen keine Zutaten.'); return; }
  const hint = $('#mp-shophint');
  // Ohne Schlüssel: die mitgelieferte Liste nehmen (stimmt, solange nichts getauscht wurde), sonst lokal zusammenführen.
  if (!hasKey()) {
    const n = addShopItems(P.shopping?.length ? P.shopping : localMerge(lines));
    toast(n ? `${n} Sachen auf die Einkaufsliste gesetzt` : 'Alles steht schon auf der Liste');
    return;
  }
  await busy($('#mp-shop'), hint, 'Claude fasst die Zutaten zusammen …', async () => {
    let items;
    try {
      const r = await askJSON(`Fasse diese Zutaten aus einem Wochen-Essensplan zu einer Einkaufsliste zusammen. Gleiche Zutaten addieren und auf übliche Packungsgrößen im Discounter runden. Grundvorräte wie Salz, Pfeffer, Gewürze, Öl, Essig, Mehl und Zucker weglassen.
Kategorien: ${CATS.join(', ')}.
Zutaten:
${lines.map(z => `- ${z.amount ? z.amount + ' ' : ''}${z.name}`).join('\n')}
Form: {"einkauf":[{"name":"Haferflocken","menge":"1 kg","kategorie":"Brot & Trockenware"}]}`, { maxTokens: 3000 });
      items = (r.einkauf || []).map(s => ({ name: String(s.name || ''), amount: String(s.menge || ''), cat: CATS.includes(s.kategorie) ? s.kategorie : 'Sonstiges' })).filter(s => s.name);
      if (!items.length) throw new Error();
    } catch { items = localMerge(lines); }
    const n = addShopItems(items);
    hint.textContent = '';
    toast(n ? `${n} Sachen auf die Einkaufsliste gesetzt` : 'Alles steht schon auf der Liste');
  });
}

async function createPlan(e) {
  e.preventDefault();
  const s = db.settings; const td = s.trainDays; const w = lastWeight(); const ich = me();
  const meals = +$('#mp-meals').value, effort = $('#mp-effort').value, pref = $('#mp-pref').value.trim();
  const start = $('#mp-start').value || today();
  const dates = [...Array(7)].map((_, i) => addDays(start, i));
  const locked = (db.mealplan?.days || []).flatMap(d => d.meals.filter(m => m.locked).map(m => ({ ...m, date: d.date })));
  const keep = locked.filter(m => dates.includes(m.date));
  const offers = $('#mp-offers').checked ? offersText() : '';
  const liked = db.dishes.map(d => d.name).slice(0, 15);
  const ctx = { dates, keep, td, meals, effort, pref };
  const bridge = !hasKey();
  const prompt = `Erstelle einen Familien-Essensplan für 7 Tage auf Deutsch. Alle essen dieselben Gerichte, nur die Portionen unterscheiden sich.
Haushalt: ${householdText()}.
Mahlzeiten pro Tag: ${slotsFor(meals).join(', ')}. Frühstück und Snacks dürfen einfach sein; Mittag kann an Werktagen etwas Mitnehmbares sein.
Trainingsziel des Erwachsenen mit Portion 1: ${db.plan?.goal || 'fit und gesund bleiben'}.${w ? ` Körpergewicht ${w} kg.` : ''}
Tagesziel für diese Portion: ${s.kcalGoal ? de(s.kcalGoal) + ' kcal' : 'keine Angabe. Wähle ein passendes, moderates Ziel und gib es in "ziel_kcal" an'}${s.proteinGoal ? `, ${de(s.proteinGoal)} g Eiweiß` : ', eiweißreich'}. An Trainingstagen etwas mehr Kohlenhydrate.
Tage:
${dates.map(dt => `${dt} (${WD[wdOf(dt)]}): ${td.includes(wdOf(dt)) ? 'Trainingstag' : 'Ruhetag'}`).join('\n')}
Aufwand: ${effort}. Wünsche: ${pref || 'keine'}.${liked.length ? ' Gerichte, die gut ankommen: ' + liked.join(', ') + '.' : ''}
Kindgerecht: nicht scharf, Gemüse gern versteckt oder als Rohkost dazu; bei Bedarf ein kurzer Tipp in "kind_tipp".
Reste und Vorkochen sinnvoll nutzen, damit der Einkauf klein bleibt. Einfache Zutaten vom Discounter.${offers ? '\nBevorzuge Zutaten aus diesen aktuellen Angeboten:\n' + offers : ''}${keep.length ? '\nDiese Mahlzeiten stehen fest und bleiben unverändert, plane drumherum: ' + keep.map(m => `${m.date} ${m.slot}: ${m.name}`).join('; ') : ''}
Nährwerte je Mahlzeit für die Portion 1. Zutatenmengen für den ganzen Haushalt (${factorStr(Math.round(familyFactor() * 10) / 10)} Portionen).
${bridge ? `Fasse außerdem alle Zutaten der Woche zu einer Einkaufsliste zusammen (gleiche addieren, auf Packungsgrößen runden, ohne Salz, Pfeffer, Gewürze, Öl, Mehl, Zucker) mit Kategorie aus: ${CATS.join(', ')}.\n` : ''}Form: {"art":"wochenplan","ziel_kcal":2500,"tage":[{"datum":"YYYY-MM-DD","mahlzeiten":[{"slot":"Frühstück","name":"…","kcal":550,"protein":35,"kohlenhydrate":60,"fett":15,"zeit":"10 min","zutaten":[{"name":"Haferflocken","menge":"200 g"}],"zubereitung":"2 bis 3 Sätze","kind_tipp":""}]}]${bridge ? ',"einkauf":[{"name":"Haferflocken","menge":"1 kg","kategorie":"Brot & Trockenware"}]' : ''}}`;
  if (bridge) { showBridge($('#mp-bridge'), prompt, r => applyMealPlan(r, ctx)); return; }
  await busy($('#mp-go'), $('#mp-hint'), 'Claude plant eure Woche. Das kann ein bis zwei Minuten dauern …', async () => {
    try { if (!applyMealPlan(await askJSON(prompt, { smart: true, maxTokens: 16000 }), ctx)) throw new Error(); }
    catch (err) { $('#mp-hint').textContent = err.code ? aiMsg(err) : 'Der Plan kam unvollständig an. Versuch es nochmal.'; }
  });
}

function applyMealPlan(r, { dates, keep, td, meals, effort, pref }) {
  const s = db.settings;
  const days = (r.tage || []).slice(0, 7).map((t, i) => {
    const dt = dates[i];
    const ms = (t.mahlzeiten || []).map(mapMeal).filter(m => m.name);
    keep.filter(k => k.date === dt).forEach(k => {
      const j = ms.findIndex(m => m.slot === k.slot); const { date, ...meal } = k;
      if (j >= 0) ms[j] = meal; else ms.push(meal);
    });
    return { date: dt, training: td.includes(wdOf(dt)), meals: ms };
  }).filter(t => t.meals.length);
  if (!days.length) return false;
  const shopping = (r.einkauf || []).map(x => ({ name: String(x.name || ''), amount: String(x.menge || ''), cat: CATS.includes(x.kategorie) ? x.kategorie : 'Sonstiges' })).filter(x => x.name);
  db.mealplan = { days, shopping, kcalTarget: num(r.ziel_kcal) || s.kcalGoal || null, mealsPerDay: meals, effort, pref, createdAt: Date.now() };
  if (!s.kcalGoal && db.mealplan.kcalTarget) s.kcalGoal = db.mealplan.kcalTarget;
  touchPlan();
  sel = null; editing = null; $('#mp-setup').open = false; $('#mp-hint').textContent = '';
  save(); toast('Wochenplan gespeichert');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

export function initPlan() {
  $('#mp-start').value = today();
  $('#mpform').onsubmit = createPlan;
  addRender(() => { renderHouse(); renderTrainChips(); renderPlanView(); });
}
