import { db, save } from './store.js';
import { S, addRender, busy, kcalFor, sportBonus } from './app.js';
import { Capacitor } from '@capacitor/core';
import { connectHealth, syncHealth } from './health.js';
import { $, $$, esc, de, num, uid, today, fmtDay, toast, armed } from './util.js';
import { ask, askJSON, aiMsg, hasKey } from './claude.js';
import { listen, takePhoto, scanBarcode, lookupFood } from './native.js';

export const SLOTS = ['Frühstück', 'Mittag', 'Nachmittag', 'Abend', 'Snack'];
let parts = [];

export function dayTotals(day = S.day) {
  const M = db.meals.filter(m => m.date === day);
  const sum = k => M.reduce((s, m) => s + (m[k] || 0), 0);
  return { M, kcal: sum('kcal'), protein: sum('protein'), carbs: sum('carbs'), fat: sum('fat') };
}
export function logMeal(m, day = S.day) {
  db.meals.push({ id: uid(), at: Date.now(), date: day, slot: SLOTS.includes(m.slot) ? m.slot : 'Snack', name: m.name, kcal: m.kcal ?? null, protein: m.protein || 0, carbs: m.carbs || 0, fat: m.fat || 0, parts: m.parts || [] });
  save();
}

function meter(label, val, goal, unit, cls) {
  const pct = goal ? val / goal * 100 : 0;
  return `<div class="meter"><div class="lbl2"><span>${label}</span><span class="num">${de(val)}${goal ? ` / ${de(goal)}` : ''} ${unit}</span></div>
    <div class="bar"><div class="fill ${cls} ${cls === '' && pct > 110 ? 'over' : ''}" style="width:${Math.min(100, pct)}%"></div></div></div>`;
}

function renderMeals() {
  const { M, kcal, protein, carbs, fat } = dayTotals(); M.sort((a, b) => a.at - b.at);
  const g = db.settings;
  const goal = kcalFor(S.day);
  const left = goal ? goal - kcal : null;
  const big = left == null
    ? `<div class="bignum"><b>${de(kcal)}</b><span>kcal gegessen</span></div>`
    : left >= 0 ? `<div class="bignum"><b>${de(left)}</b><span>kcal übrig von ${de(goal)}${sportBonus(S.day) ? ` (inkl. +${de(sportBonus(S.day))} Sport)` : ''}</span></div>`
    : `<div class="bignum"><b class="kcal">${de(-left)}</b><span>kcal über dem Ziel</span></div>`;
  $('#m-summary').innerHTML = `<h3>${S.day === today() ? 'Heute' : fmtDay(S.day)}</h3>` + big +
    meter('Kalorien', kcal, goal, 'kcal', '') + meter('Eiweiß', protein, g.proteinGoal, 'g', 'p') +
    `<p class="small muted">Kohlenhydrate ${de(carbs)} g · Fett ${de(fat)} g${!goal ? ' · Tagesziele legst du über das Zahnrad fest.' : ''}</p>`;
  $('#m-list').innerHTML = M.length ? '<div class="list">' + SLOTS.map(sl => {
    const xs = M.filter(m => m.slot === sl); if (!xs.length) return '';
    return `<div class="group-h"><span>${sl}</span><span class="num">${de(xs.reduce((s, m) => s + (m.kcal || 0), 0))} kcal</span></div>` +
      xs.map(m => `<div class="item"><div class="main"><div class="t">${esc(m.name)}</div><div class="s">${m.kcal != null ? `<span class="kcal">${de(m.kcal)} kcal</span> · ` : ''}E ${de(m.protein)} · K ${de(m.carbs)} · F ${de(m.fat)} g</div></div><button type="button" class="del" data-mdel="${m.id}">Entfernen</button></div>`).join('');
  }).join('') + '</div>' : '<div class="empty">Noch nichts eingetragen. Sprich oder tipp oben ein, was du gegessen hast, oder hak im Wochenplan ein Gericht als gegessen ab.</div>';
  $$('[data-mdel]').forEach(b => b.onclick = () => { if (!armed(b)) return; db.meals = db.meals.filter(m => m.id !== b.dataset.mdel); save(); });
  renderQuick(); renderDishes(); renderActivity();
  // Ohne Schlüssel nur zeigen, was auch funktioniert.
  const k = hasKey();
  $('#m-est').hidden = !k; $('#m-photo').hidden = !k; $('#m-tipcard').hidden = !k;
}

/** Ein-Tipp-Eintragen: geplante Gerichte von heute, dann zuletzt Gegessenes und gemerkte Gerichte. */
function renderQuick() {
  const box = $('#m-quick'); const seen = new Set(); const items = [];
  const push = (m, label) => { const k = m.name.toLowerCase(); if (seen.has(k) || items.length >= 10) return; seen.add(k); items.push({ ...m, label }); };
  const eaten = new Set(db.meals.filter(m => m.date === S.day).map(m => m.name.toLowerCase()));
  (db.mealplan?.days.find(d => d.date === S.day)?.meals || []).filter(m => !eaten.has(m.name.toLowerCase())).forEach(m => push(m, 'Plan'));
  [...db.meals].sort((a, b) => b.at - a.at).filter(m => m.date !== S.day || true).forEach(m => push(m, ''));
  db.dishes.forEach(m => push(m, ''));
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<h3>Schnell eintragen</h3><div class="recent">${items.map((m, i) => `<button type="button" class="sm" data-quick="${i}">${m.label ? '<span class="tag">Plan</span> ' : ''}${esc(m.name.length > 28 ? m.name.slice(0, 27) + '…' : m.name)} · ${de(m.kcal)}</button>`).join('')}</div>
    <p class="small muted">Ein Tipp trägt es für ${S.day === today() ? 'heute' : fmtDay(S.day)} ein.</p>`;
  box.querySelectorAll('[data-quick]').forEach(b => b.onclick = () => {
    const m = items[+b.dataset.quick];
    logMeal({ slot: m.label ? m.slot : guessSlot(), name: m.name, kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, parts: m.parts });
    toast(`✓ ${m.name}`);
  });
}

/* ---------- Bestandteile ---------- */
function renderParts() {
  const box = $('#m-parts');
  box.innerHTML = parts.length ? '<div class="parts">' + parts.map((p, i) => `<div class="item"><div class="main"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.amount || '')}${p.amount ? ' · ' : ''}<span class="kcal">${de(p.kcal)} kcal</span> · E ${de(p.protein)} g</div></div><button type="button" class="del" data-rmpart="${i}" aria-label="Bestandteil entfernen">×</button></div>`).join('') + '</div>' : '';
  box.querySelectorAll('[data-rmpart]').forEach(b => b.onclick = () => { parts.splice(+b.dataset.rmpart, 1); fillFromParts(); renderParts(); });
}
function fillFromParts() {
  if (!parts.length) return;
  const s = k => Math.round(parts.reduce((a, p) => a + (p[k] || 0), 0));
  $('#m-kcal').value = s('kcal'); $('#m-p').value = s('protein'); $('#m-c').value = s('carbs'); $('#m-f').value = s('fat');
  macSum();
}
/** Zusammenfassung im eingeklappten „Nährwerte“-Feld. */
function macSum() {
  const k = num($('#m-kcal').value);
  $('#m-macsum').textContent = k != null ? `Nährwerte: ${de(k)} kcal · ${de(num($('#m-p').value))} g Eiweiß` : 'Nährwerte (optional)';
}
const mapParts = arr => (Array.isArray(arr) ? arr : []).map(p => ({ name: String(p.name || ''), amount: String(p.menge || ''), kcal: num(p.kcal) || 0, protein: num(p.protein) || 0, carbs: num(p.kohlenhydrate) || 0, fat: num(p.fett) || 0 })).filter(p => p.name);

async function estimate({ text, image, append }) {
  const hint = $('#m-hint');
  await busy($('#m-est'), hint, image ? 'Claude schaut sich deinen Teller an …' : 'Claude rechnet …', async () => {
    try {
      const r = await askJSON(`Schätze die Nährwerte ${image ? 'des Essens auf dem Foto' : 'dieser Mahlzeit'}.${text ? ` Beschreibung: "${text}".` : ''}
Zerlege sie in Bestandteile mit geschätzter Menge. Nimm übliche deutsche Lebensmittel an und, wenn keine Menge genannt oder erkennbar ist, eine normale Portion für einen Erwachsenen.
Form: {"name":"kurzer Name des Gerichts","bestandteile":[{"name":"Reis, gekocht","menge":"150 g","kcal":195,"protein":4,"kohlenhydrate":42,"fett":1}],"annahme":"ein kurzer Satz zu deinen Annahmen"}
${image ? 'Wenn auf dem Foto kein Essen zu sehen ist: {"fehler":"kurzer Grund"}.' : ''}`, image ? { smart: true, images: [image] } : {});
      if (r.fehler) { hint.textContent = 'Kein Essen erkannt: ' + r.fehler; return; }
      const p = mapParts(r.bestandteile); if (!p.length) throw new Error();
      parts = append ? parts.concat(p) : p;
      if (!append && r.name && (image || !$('#m-name').value.trim())) $('#m-name').value = r.name;
      fillFromParts(); renderParts();
      hint.textContent = r.annahme ? 'Geschätzt: ' + r.annahme : 'Geschätzt. Prüf die Werte kurz.';
    } catch (e) { hint.textContent = e.code ? aiMsg(e) : 'Das hat nicht geklappt. Formulier es anders oder trag die Werte selbst ein.'; }
  });
}

/* ---------- Barcode ---------- */
async function barcodeFlow() {
  const hint = $('#m-hint'); const box = $('#m-bcbox');
  let code;
  try { code = await scanBarcode(); } catch (e) { hint.textContent = e.message; return; }
  if (!code) return;
  hint.textContent = 'Suche Produkt ' + code + ' …';
  let p;
  try { p = await lookupFood(code); } catch (e) { hint.textContent = e.message; return; }
  if (!p) { hint.textContent = 'Produkt nicht in der Datenbank. Beschreib es einfach und lass schätzen.'; return; }
  hint.textContent = '';
  box.innerHTML = `<div class="card" style="background:var(--bg)"><div class="t">${esc(p.name)}</div>
    <p class="small muted">pro 100 g: ${de(p.kcal)} kcal · E ${de(p.protein, 1)} · K ${de(p.carbs, 1)} · F ${de(p.fat, 1)} g${p.servingLabel ? ' · Portion ' + esc(p.servingLabel) : ''}</p>
    <div class="row wide"><label for="bc-g">Menge in g<input id="bc-g" inputmode="decimal" value="${p.serving || 100}"></label><div class="bottom"><button type="button" class="primary" id="bc-add">Dazu</button></div></div></div>`;
  $('#bc-add').onclick = () => {
    const g = num($('#bc-g').value) || 100, f = g / 100;
    parts.push({ name: p.name, amount: de(g) + ' g', kcal: p.kcal * f, protein: p.protein * f, carbs: p.carbs * f, fat: p.fat * f });
    if (!$('#m-name').value.trim()) $('#m-name').value = p.name;
    box.innerHTML = ''; fillFromParts(); renderParts();
  };
}

/* ---------- Gerichte ---------- */
function fillMeal(d) {
  $('#m-name').value = d.name; $('#m-kcal').value = d.kcal != null ? Math.round(d.kcal) : '';
  $('#m-p').value = Math.round(d.protein || 0); $('#m-c').value = Math.round(d.carbs || 0); $('#m-f').value = Math.round(d.fat || 0);
  parts = (d.parts || []).slice(); renderParts(); macSum();
  $('#m-hint').textContent = 'Übernommen. Passe die Werte an, wenn die Portion anders war.';
  $('#mform').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderDishes() {
  const D = [...db.dishes].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  $('#m-dishes-sum').textContent = `Meine Gerichte (${D.length})`;
  $('#m-dishes').innerHTML = D.length
    ? '<div class="list">' + D.map(d => `<div class="item"><div class="main"><div class="t">${esc(d.name)}</div><div class="s"><span class="kcal">${de(d.kcal)} kcal</span> · E ${de(d.protein)} g</div></div><button type="button" class="sm" data-usedish="${d.id}">Übernehmen</button><button type="button" class="del" data-ddel="${d.id}">×</button></div>`).join('') + '</div>'
    : '<p class="small muted">Hak beim Eintragen „Als Gericht merken“ an, dann trägst du es hier mit einem Tipp wieder ein. Lieblingsgerichte fließen auch in den Wochenplan ein.</p>';
  $$('[data-usedish]').forEach(b => b.onclick = () => { const d = db.dishes.find(x => x.id === b.dataset.usedish); if (d) fillMeal(d); });
  $$('[data-ddel]').forEach(b => b.onclick = () => { if (!armed(b)) return; db.dishes = db.dishes.filter(d => d.id !== b.dataset.ddel); save(); });
}

function resetForm() {
  ['#m-name', '#m-kcal', '#m-p', '#m-c', '#m-f'].forEach(i => ($(i).value = ''));
  $('#m-hint').textContent = ''; $('#m-fav').checked = false; $('#m-bcbox').innerHTML = ''; parts = []; renderParts(); macSum();
}
const guessSlot = () => { const h = new Date().getHours(); return h < 10 ? 'Frühstück' : h < 13 ? 'Mittag' : h < 17 ? 'Nachmittag' : h < 21 ? 'Abend' : 'Snack'; };

async function getTip() {
  const out = $('#m-tip');
  const { M, kcal, protein, carbs, fat } = dayTotals(); const g = db.settings;
  const trained = db.workouts.filter(w => w.date === S.day).map(w => w.ex);
  const planned = db.mealplan?.days.find(d => d.date === S.day)?.meals.map(m => `${m.slot}: ${m.name}`) || [];
  await busy($('#m-tipbtn'), null, '', async () => {
    out.innerHTML = '<p class="small muted">Claude überlegt …</p>';
    try {
      const r = await ask(`Du bist ein freundlicher Ernährungscoach. Gib 2 bis 3 kurze, konkrete Tipps auf Deutsch für den Rest des Tages, ausgewogen und alltagstauglich, keine Crash-Diäten. Höchstens 80 Wörter, jede Zeile beginnt mit "• ".
Tag: ${S.day === today() ? 'heute' : fmtDay(S.day)}, Uhrzeit ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}.
Bisher gegessen: ${M.length ? M.map(m => `${m.name} (${de(m.kcal)} kcal)`).join('; ') : 'noch nichts eingetragen'}.
Summe: ${de(kcal)} kcal, ${de(protein)} g Eiweiß, ${de(carbs)} g Kohlenhydrate, ${de(fat)} g Fett.
Tagesziel heute: ${kcalFor(S.day) ? de(kcalFor(S.day)) + ' kcal' : 'keins'}, ${g.proteinGoal ? de(g.proteinGoal) + ' g Eiweiß' : 'kein Eiweißziel'}.
${planned.length ? 'Laut Wochenplan heute noch vorgesehen: ' + planned.join('; ') + '.' : ''}
Trainingsziel: ${db.plan?.goal || 'nicht angegeben'}. Heute trainiert: ${trained.length ? trained.join(', ') : 'nein'}.`, { maxTokens: 500 });
      out.innerHTML = `<div class="ai">${esc(r.text)}</div>`;
    } catch (e) { out.innerHTML = `<p class="small muted">${esc(aiMsg(e))}</p>`; }
  });
}

/* Sport von der Uhr: verbrannte Kalorien und Schritte, von Hand abgetippt. */
function renderActivity() {
  const a = db.activity?.[S.day] || {};
  ['kcal', 'steps'].forEach(k => { const el = $('#act-' + k); if (document.activeElement !== el) el.value = a[k] || ''; });
  const b = sportBonus(S.day), auto = db.settings.healthSync;
  $('#act-sub').textContent = auto ? '· automatisch von der Uhr' : '· von der Uhr abtippen';
  $('#act-hint').textContent = [b ? `+${de(b)} kcal fürs Essen (die Hälfte der Sport-Kalorien).` : '',
    auto && a.src === 'hand' ? 'Von Hand geändert, wird nicht überschrieben.' : '',
    auto && db.settings.healthAt ? `Abgeglichen ${new Date(db.settings.healthAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr.` : ''].filter(Boolean).join(' ');
  $('#act-connect').hidden = auto || !Capacitor.isNativePlatform();
  $('#act-sync').hidden = !auto;
}
function saveActivity() {
  const kcal = Math.max(0, Math.round(num($('#act-kcal').value) || 0)), steps = Math.max(0, Math.round(num($('#act-steps').value) || 0));
  db.activity = db.activity || {};
  if (kcal || steps) db.activity[S.day] = { kcal, steps, src: 'hand' }; else delete db.activity[S.day];
  save();
}

export function initEssen() {
  ['#act-kcal', '#act-steps'].forEach(i => $(i).addEventListener('change', saveActivity));
  $('#act-connect').onclick = async () => {
    try { const msg = await connectHealth(); toast(msg || 'Verbunden. Schritte und Sport-Kalorien kommen jetzt von selbst.'); }
    catch (e) { toast('Verbinden hat nicht geklappt: ' + (e.message || e)); }
    renderActivity();
  };
  $('#act-sync').onclick = async () => {
    const a = db.activity?.[S.day]; if (a?.src === 'hand') a.src = 'uhr';
    await syncHealth(); renderActivity(); toast('Mit der Uhr abgeglichen');
  };
  $('#m-slot').value = guessSlot();
  macSum();
  ['#m-kcal', '#m-p'].forEach(i => $(i).addEventListener('input', macSum));
  $('#m-est').onclick = () => { const t = $('#m-name').value.trim(); if (!t) { $('#m-name').focus(); return; } estimate({ text: t }); };
  $('#m-photo').onclick = async () => {
    try { const img = await takePhoto(); if (img) estimate({ text: $('#m-name').value.trim(), image: img }); }
    catch (e) { $('#m-hint').textContent = e.message; }
  };
  $('#m-bc').onclick = barcodeFlow;
  $('#m-mic').onclick = async () => {
    try {
      const t = await listen('Was hast du gegessen?'); if (!t) return;
      $('#m-name').value = t;
      if (hasKey()) estimate({ text: t }); else $('#m-hint').textContent = 'Trag die Werte selbst ein oder hinterlege den API-Schlüssel zum Schätzen.';
    } catch (e) { toast(e.message); }
  };
  $('#m-tipbtn').onclick = getTip;
  $('#mform').onsubmit = e => {
    e.preventDefault();
    const name = $('#m-name').value.trim(); if (!name) return;
    const vals = { name, kcal: num($('#m-kcal').value), protein: num($('#m-p').value) || 0, carbs: num($('#m-c').value) || 0, fat: num($('#m-f').value) || 0, parts };
    if ($('#m-fav').checked && !db.dishes.some(d => d.name.toLowerCase() === name.toLowerCase())) db.dishes.push({ id: uid(), ...vals });
    logMeal({ ...vals, slot: $('#m-slot').value });
    resetForm(); toast('Eingetragen');
  };
  addRender(renderMeals);
}
