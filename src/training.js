import { db, save } from './store.js';
import { S, addRender, busy, lastWeight, defaultTrainDays } from './app.js';
import { $, esc, de, num, uid, iso, today, addDays, fmtDay, toast, armed, wdOf } from './util.js';
import { askJSON, aiMsg, hasKey } from './claude.js';
import { listen, setTimer, buzz, scheduleTraining } from './native.js';
import { showBridge } from './bridge.js';

const setStr = w => `${w.sets} × ${w.reps}${w.kg ? ` · ${de(w.kg, 1)} kg` : ''}`;
const sortKey = w => w.date + String(w.at).padStart(14, '0');
export const lastOf = (name, real) => db.workouts
  .filter(w => w.ex.toLowerCase() === String(name).toLowerCase() && !(real && w.deload))
  .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))[0];

/* ---------- Planlogik ---------- */
function repRange(r) { const m = String(r).match(/(\d+)\D+(\d+)/); if (m) return [+m[1], +m[2]]; const n = parseInt(r) || 10; return [n, n]; }
export function planWeek(p) {
  const start = p.start || iso(p.createdAt || Date.now());
  return Math.floor((new Date(S.day + 'T12:00') - new Date(start + 'T12:00')) / (7 * 864e5)) + 1;
}
function planPhase(p, wk) {
  return (p.phases || []).find(ph => {
    const m = String(ph.weeks).match(/(\d+)(?:\D+(\d+))?/); if (!m) return false;
    const a = +m[1], b = m[2] ? +m[2] : a; return wk >= a && wk <= b;
  }) || null;
}
const isDeload = ph => !!ph && /erhol|deload|leicht|entlast/i.test(ph.title + ' ' + (ph.note || ''));
const r25 = v => Math.round(v * 4) / 4;
function nextTarget(x, deload) {
  const lw = lastOf(x.name, true); const [lo, hi] = repRange(x.reps);
  if (!lw) return null;
  if (!lw.kg) return { kg: 0, reps: Math.min(hi, (lw.reps || lo) + 1) };
  if (deload) return { kg: r25(lw.kg * 0.85), reps: lo, deload: true };
  if ((lw.reps || 0) >= hi) return { kg: r25(lw.kg + (lw.kg >= 30 ? 2.5 : 1)), reps: lo, up: true };
  return { kg: lw.kg, reps: Math.min(hi, Math.max(lo, (lw.reps || lo) + 1)) };
}
function autoPlanDay(plan) {
  const n = plan.days.length;
  const W = db.workouts.filter(w => w.planDay != null && w.date <= S.day).sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const l = W[0]; if (!l) return 0;
  if (l.date === S.day) return l.planDay % n;
  return (l.planDay + 1) % n;
}
const restSeconds = () => { const g = db.plan?.goal || ''; return /Kraft/.test(g) ? 150 : /Abnehmen/.test(g) ? 60 : 90; };

let planSel = null, pendingPlanDay = null;
export const resetPlanSel = () => { planSel = null; };

function renderPlan() {
  const plan = db.plan; const v = $('#plan-view');
  $('#plan-sum').textContent = plan ? 'Neuen Trainingsplan erstellen' : 'Trainingsplan erstellen lassen';
  if (!plan || !(plan.days || []).length) {
    v.hidden = true;
    if (!renderPlan.opened) { $('#plan-setup').open = true; renderPlan.opened = true; }
    return;
  }
  v.hidden = false;
  const idx = planSel ?? autoPlanDay(plan); const d = plan.days[idx];
  const done = new Set(db.workouts.filter(w => w.date === S.day).map(w => w.ex.toLowerCase()));
  const wk = planWeek(plan), total = plan.weeks || 0;
  const ph = planPhase(plan, Math.max(1, wk)), deload = wk >= 1 && isDeload(ph);
  const isTrain = db.settings.trainDays.includes(wdOf(S.day));
  const head = wk < 1
    ? `<p class="small">Startet am ${fmtDay(plan.start)}. Bis dahin kannst du dir die Übungen schon ansehen.</p>`
    : total ? `<div class="meter"><div class="lbl2"><span>${wk > total ? 'Zyklus abgeschlossen' : `Woche ${wk} von ${total}`}${ph ? ` · ${esc(ph.title)}` : ''}</span><span>${isTrain ? 'Trainingstag' : 'Ruhetag'}</span></div>
      <div class="bar"><div class="fill p" style="width:${Math.min(100, wk / total * 100)}%"></div></div>
      ${ph?.note ? `<p class="small muted">${esc(ph.note)}</p>` : ''}
      ${wk > total ? '<p class="small">Zeit für einen neuen Plan. Unten erstellen, deine bisherigen Gewichte fließen ein.</p>' : ''}</div>` : '';
  v.innerHTML = `<div class="actions between"><h3>${esc(plan.name || 'Dein Plan')}</h3><span class="small muted">${esc(plan.goal)} · ${plan.daysPerWeek}× pro Woche</span></div>
  ${head}
  <div class="filter">${plan.days.map((x, i) => `<button type="button" data-pday="${i}" aria-pressed="${i === idx}">${esc(x.title.split(/[–-]/)[0].trim() || 'Tag ' + (i + 1))}</button>`).join('')}</div>
  <div><h4>${esc(d.title)}</h4>${d.focus ? `<p class="small muted">${esc(d.focus)}</p>` : ''}</div>
  <div>${d.exercises.map((x, i) => exHTML(x, i, nextTarget(x, deload))).join('')}</div>
  ${plan.warmup || plan.cardio || (plan.tips || []).length ? `<details><summary>Aufwärmen, Ausdauer, Ernährung</summary><div class="stack small" style="gap:6px">${plan.warmup ? `<p><b>Aufwärmen:</b> ${esc(plan.warmup)}</p>` : ''}${plan.cardio ? `<p><b>Ausdauer:</b> ${esc(plan.cardio)}</p>` : ''}${(plan.tips || []).map(t => `<p>• ${esc(t)}</p>`).join('')}</div></details>` : ''}
  <p class="small muted">Schaffst du in allen Sätzen das obere Ende der Wiederholungen, schlägt die App beim nächsten Mal mehr Gewicht vor.</p>`;
  v.querySelectorAll('[data-pday]').forEach(b => b.onclick = () => { planSel = +b.dataset.pday; renderPlan(); });
  // Ein Tipp: Ziel von heute übernehmen. Beim ersten Mal (noch kein Gewicht) direkt anpassen lassen.
  v.querySelectorAll('[data-done]').forEach(b => b.onclick = () => {
    const i = +b.dataset.done, x = d.exercises[i], tg = nextTarget(x, deload);
    if (!tg) { openAdj(i, x, tg); return; }
    logEx(x.name, x.sets || 3, tg.reps, tg.kg, idx, deload);
  });
  v.querySelectorAll('[data-adj]').forEach(b => b.onclick = () => { const i = +b.dataset.adj; if (adj?.i === i) { adj = null; renderPlan(); } else openAdj(i, d.exercises[i], nextTarget(d.exercises[i], deload)); });
  v.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => { db.workouts = db.workouts.filter(w => w.id !== b.dataset.undo); save(); toast('Rückgängig gemacht'); });
  v.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
    const [k, delta] = b.dataset.step.split(':'); const step = Number(delta);
    if (k === 'kg') adj.kg = Math.max(0, r25((num($('#adj-kg').value) || 0) + step));
    else adj[k] = Math.max(1, adj[k] + step);
    renderPlan();
  });
  const kgIn = v.querySelector('#adj-kg'); if (kgIn) kgIn.onchange = () => { adj.kg = num(kgIn.value) || 0; };
  v.querySelectorAll('[data-adjsave]').forEach(b => b.onclick = () => {
    const x = d.exercises[adj.i]; const kg = num($('#adj-kg').value) ?? adj.kg;
    logEx(x.name, adj.sets, adj.reps, kg || 0, idx, deload); adj = null;
  });
}

let adj = null;
function openAdj(i, x, tg) {
  const lw = lastOf(x.name);
  adj = { i, sets: x.sets || 3, reps: tg?.reps || repRange(x.reps)[0], kg: tg?.kg ?? lw?.kg ?? 0, first: !tg };
  renderPlan();
}
function logEx(ex, sets, reps, kg, planDay, deload) {
  const w = { id: uid(), at: Date.now(), date: S.day, ex, sets, reps, kg, planDay };
  if (deload) w.deload = true;
  db.workouts.push(w); save();
  toast(`✓ ${ex}: ${sets} × ${reps}${kg ? ' · ' + de(kg, 2) + ' kg' : ''}`);
}

const yt = n => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(n + ' richtig ausführen');
function howHTML(x) {
  const h = x.how || {};
  const li = a => (a || []).filter(Boolean);
  return `<details class="full"><summary>So geht's</summary><div class="stack small" style="gap:8px">
    ${h.muscles ? `<p><b>Trainiert:</b> ${esc(h.muscles)}</p>` : ''}
    ${h.setup ? `<p><b>Einstellen:</b> ${esc(h.setup)}</p>` : ''}
    ${li(h.steps).length ? `<div><b>Ablauf</b><ol style="margin:4px 0 0;padding-left:20px">${li(h.steps).map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>` : ''}
    ${h.breath ? `<p><b>Atmung:</b> ${esc(h.breath)}</p>` : ''}
    ${li(h.mistakes).length ? `<div><b>Typische Fehler</b><ul style="margin:4px 0 0;padding-left:20px">${li(h.mistakes).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    ${h.start ? `<p><b>Startgewicht:</b> ${esc(h.start)}</p>` : ''}
    ${h.alt ? `<p><b>Gerät besetzt?</b> ${esc(h.alt)}</p>` : ''}
    ${!x.how && x.tip ? `<p>${esc(x.tip)}</p>` : ''}
    <p><a href="${yt(x.name)}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">Video dazu ansehen ↗</a></p>
  </div></details>`;
}
function exHTML(x, i, tg) {
  const logged = db.workouts.filter(w => w.date === S.day && w.ex.toLowerCase() === x.name.toLowerCase()).pop();
  const target = tg ? `heute ${tg.kg ? de(tg.kg, 2) + ' kg × ' : ''}${tg.reps}` : 'erstes Mal: Startgewicht wählen';
  const panel = adj?.i === i ? `<div class="full stepper">
      ${adj.first ? '<p class="small muted">Wähl ein Gewicht, bei dem nach den Wiederholungen noch 2–3 gegangen wären. Mehr dazu unter „So geht\'s“.</p>' : ''}
      <div class="steprow"><span>Sätze</span><button type="button" class="sm" data-step="sets:-1">−</button><b>${adj.sets}</b><button type="button" class="sm" data-step="sets:1">+</button></div>
      <div class="steprow"><span>Wdh.</span><button type="button" class="sm" data-step="reps:-1">−</button><b>${adj.reps}</b><button type="button" class="sm" data-step="reps:1">+</button></div>
      <div class="steprow"><span>kg</span><button type="button" class="sm" data-step="kg:-2.5">−2,5</button><input id="adj-kg" inputmode="decimal" value="${String(adj.kg).replace('.', ',')}" aria-label="Gewicht in kg"><button type="button" class="sm" data-step="kg:2.5">+2,5</button></div>
      <button type="button" class="primary" data-adjsave>Speichern</button></div>` : '';
  return `<div class="ex ${logged ? 'logged' : ''}"><div class="main"><div class="t">${esc(x.name)}</div>
    <div class="s">${logged ? `erledigt: ${setStr(logged)}` : `${x.sets} × ${esc(x.reps)} · ${target}${tg?.up ? ' <span class="chip t">steigern</span>' : ''}${tg?.deload ? ' <span class="chip mute">leichter</span>' : ''}`}</div></div>
    <div class="actions" style="justify-content:flex-end">${logged
      ? `<button type="button" class="sm ghost" data-undo="${logged.id}">Rückgängig</button>`
      : `<button type="button" class="sm primary" data-done="${i}">✓ Erledigt</button><button type="button" class="sm ghost" data-adj="${i}" aria-label="Anpassen">±</button>`}</div>
    ${panel}${howHTML(x)}</div>`;
}

/* ---------- Satzpause ---------- */
let restLeft = 0, restTotal = 0, restInt = null;
function renderRest() {
  const box = $('#rest');
  if (!db.plan) { box.hidden = true; return; }
  box.hidden = false;
  if (!restTotal) restTotal = restSeconds();
  const left = restInt ? restLeft : restTotal;
  const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
  box.innerHTML = `<div class="actions between"><h3>Satzpause</h3><span class="small muted">${restInt ? 'läuft' : 'bereit'}</span></div>
    <div class="timer" id="rest-t">${mm}:${ss}</div>
    <div class="actions" style="justify-content:center">
      <button type="button" class="sm" id="rest-minus">−15 s</button>
      <button type="button" class="primary" id="rest-go">${restInt ? 'Stopp' : 'Start'}</button>
      <button type="button" class="sm" id="rest-plus">+15 s</button>
      <button type="button" class="sm ghost" id="rest-phone">Handy-Timer</button>
    </div>`;
  $('#rest-minus').onclick = () => { restTotal = Math.max(15, restTotal - 15); if (restInt) restLeft = Math.max(1, restLeft - 15); renderRest(); };
  $('#rest-plus').onclick = () => { restTotal += 15; if (restInt) restLeft += 15; renderRest(); };
  $('#rest-go').onclick = () => (restInt ? stopRest() : startRest());
  $('#rest-phone').onclick = async () => { try { await setTimer(restTotal, 'Satzpause'); toast('Timer läuft in der Uhr-App'); } catch (e) { toast(e.message); } };
}
function startRest() {
  restLeft = restTotal; clearInterval(restInt);
  restInt = setInterval(() => {
    restLeft--;
    const el = $('#rest-t');
    if (el) el.textContent = `${Math.floor(restLeft / 60)}:${String(restLeft % 60).padStart(2, '0')}`;
    if (restLeft <= 0) { stopRest(); buzz(); toast('Pause vorbei, nächster Satz'); }
  }, 1000);
  renderRest();
}
function stopRest() { clearInterval(restInt); restInt = null; renderRest(); }

/* ---------- Tagebuch ---------- */
function renderLog() {
  const W = db.workouts;
  const names = [...new Set(W.map(w => w.ex).concat((db.plan?.days || []).flatMap(d => d.exercises.map(x => x.name))))].sort((a, b) => a.localeCompare(b, 'de'));
  $('#exlist').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
  const day = W.filter(w => w.date === S.day).sort((a, b) => a.at - b.at);
  const vol = day.reduce((s, w) => s + (w.sets || 0) * (w.reps || 0) * (w.kg || 0), 0);
  const sets = day.reduce((s, w) => s + (w.sets || 0), 0);
  const days = new Set(W.filter(w => w.date >= addDays(S.day, -6) && w.date <= S.day).map(w => w.date)).size;
  const goal = db.plan?.daysPerWeek;
  $('#w-stats').innerHTML = `<div class="stat"><b>${de(sets)}</b><span>Sätze</span></div><div class="stat"><b>${de(vol)}</b><span>Volumen kg</span></div><div class="stat"><b>${days}${goal ? ' / ' + goal : ''}</b><span>Tage, 7 T.</span></div>`;
  $('#w-list').innerHTML = day.length
    ? '<div class="list">' + day.map(w => `<div class="item"><div class="main"><div class="t">${esc(w.ex)}</div><div class="s">${setStr(w)}</div></div><button type="button" class="del" data-wdel="${w.id}">Entfernen</button></div>`).join('') + '</div>'
    : '<div class="empty">Für diesen Tag ist noch nichts eingetragen.</div>';
  $('#w-list').querySelectorAll('[data-wdel]').forEach(b => b.onclick = () => { if (!armed(b)) return; db.workouts = db.workouts.filter(w => w.id !== b.dataset.wdel); save(); });
  exHint();
}
function exHint() {
  const n = $('#w-ex').value.trim(); const prev = n && lastOf(n);
  $('#w-hint').textContent = prev ? `Zuletzt ${prev.date === today() ? 'heute' : fmtDay(prev.date)}: ${setStr(prev)}` : '';
}

/* ---------- Sprache ---------- */
function parseLocal(t) {
  const m = t.match(/^(.*?)\s+(\d+)\s*(?:mal|x|×|sätze?)\s*(\d+)(?:.*?(\d+(?:[.,]\d+)?)\s*(?:kilo|kg))?/i);
  return m ? { uebung: m[1].trim(), saetze: +m[2], wdh: +m[3], kg: num(m[4]) } : { uebung: t };
}
async function voiceWorkout() {
  let t;
  try { t = await listen('Zum Beispiel: Bankdrücken 3 mal 10 mit 60 Kilo'); } catch (e) { toast(e.message); return; }
  if (!t) return;
  let r = parseLocal(t);
  if (hasKey()) {
    $('#w-hint').textContent = 'Verstanden: „' + t + '“ …';
    const names = (db.plan?.days || []).flatMap(d => d.exercises.map(x => x.name));
    try {
      r = await askJSON(`Wandle diese gesprochene Trainingsnotiz in Daten um: "${t}".
${names.length ? 'Wenn die Übung zu einer dieser passt, nimm genau diesen Namen: ' + [...new Set(names)].join(', ') + '.' : ''}
Form: {"uebung":"Bankdrücken","saetze":3,"wdh":10,"kg":60}. Unbekannte Werte als null.`);
    } catch { /* lokale Erkennung reicht */ }
  }
  if (r.uebung) $('#w-ex').value = r.uebung;
  if (r.saetze) $('#w-sets').value = r.saetze;
  if (r.wdh) $('#w-reps').value = r.wdh;
  if (r.kg != null) $('#w-kg').value = String(r.kg).replace('.', ',');
  exHint();
  $('#w-hint').textContent = `Verstanden: „${t}“. Prüfen und eintragen.`;
}

/* ---------- Plan erstellen ---------- */
async function createPlan(e) {
  e.preventDefault();
  const goal = $('#p-goal').value, days = +$('#p-days').value, level = $('#p-level').value, time = $('#p-time').value;
  const notes = $('#p-notes').value.trim(), start = $('#p-start').value || today();
  const w = lastWeight();
  const hist = [...new Set(db.workouts.filter(x => x.kg).map(x => x.ex))].slice(0, 20)
    .map(n => { const l = lastOf(n, true); return l ? `${n} ${de(l.kg, 1)} kg × ${l.reps}` : ''; }).filter(Boolean).join('; ');
  const meta = { goal, days, level, time, notes, start };
  const prompt = `Erstelle einen Trainingsplan fürs Fitnessstudio auf Deutsch für jemanden, der keine Vorkenntnisse über Übungen voraussetzen möchte.
Ziel: ${goal}. Trainingstage pro Woche: ${days}. Erfahrung: ${level}. Zeit pro Einheit: ${time}.${w ? ` Körpergewicht: ${w} kg.` : ''}
Wünsche oder Einschränkungen: ${notes || 'keine'}.${hist ? `\nBisherige Arbeitsgewichte: ${hist}.` : ''}
Plane einen kompletten Zyklus über 8 bis 12 Wochen mit Phasen (zum Beispiel Eingewöhnung, Aufbau, Steigerung) und einer leichteren Erholungswoche. Steigerung als doppelte Progression: Wer in allen Sätzen das obere Ende der Wiederholungen schafft, erhöht beim nächsten Mal das Gewicht.
Gib genau ${days} unterschiedliche Trainingstage (Tag A, Tag B, …), je 5 bis 6 Übungen. Bevorzuge Geräte und Kabelzug, die leicht zu lernen und in normalen Studios Standard sind. Sätze als Zahl, Wiederholungen als Bereich wie "8-10".
Erkläre jede Übung so, dass man sie allein am Gerät richtig ausführen kann: welche Muskeln, wie man das Gerät einstellt, Ablauf in 3 bis 5 kurzen Schritten, Atmung, 2 typische Fehler, wie man das Startgewicht findet und eine Alternative, falls das Gerät besetzt ist. Kurze, klare Sätze.
Dazu ein Satz zum Aufwärmen, ein Satz zu Ausdauertraining passend zum Ziel und 3 kurze, ausgewogene Ernährungstipps (keine Crash-Diäten).
Form: {"art":"trainingsplan","name":"kurzer Planname","wochen":10,"phasen":[{"wochen":"1-2","titel":"Eingewöhnung","hinweis":"ein Satz"}],"aufwaermen":"…","ausdauer":"…","tage":[{"titel":"Tag A – Ganzkörper","fokus":"ein Satz","uebungen":[{"name":"Beinpresse","saetze":3,"wdh":"10-12","muskeln":"Oberschenkel, Po","einstellen":"…","ablauf":["…","…","…"],"atmung":"…","fehler":["…","…"],"startgewicht":"…","alternative":"…"}]}],"ernaehrung":["…"]}`;
  if (!hasKey()) {
    showBridge($('#p-bridge'), prompt, r => applyPlan(r, meta));
    return;
  }
  await busy($('#p-go'), $('#p-hint'), 'Claude stellt deinen Plan zusammen. Das dauert etwa eine Minute …', async () => {
    try { if (!applyPlan(await askJSON(prompt, { smart: true, maxTokens: 12000 }), meta)) throw new Error(); }
    catch (err) { $('#p-hint').textContent = err.code ? aiMsg(err) : 'Der Plan kam unvollständig an. Versuch es nochmal.'; }
  });
}

const str = v => String(v || '');
const arr = v => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
/** Übernimmt einen Plan aus der Claude-Antwort. Gibt false zurück, wenn es keiner ist. */
function applyPlan(r, meta) {
  const daysArr = (r.tage || []).map(t => ({
    title: str(t.titel), focus: str(t.fokus),
    exercises: (t.uebungen || []).map(u => ({
      name: str(u.name), sets: num(u.saetze) || 3, reps: String(u.wdh || '10'), tip: str(u.hinweis),
      how: { muscles: str(u.muskeln), setup: str(u.einstellen), steps: arr(u.ablauf), breath: str(u.atmung), mistakes: arr(u.fehler), start: str(u.startgewicht), alt: str(u.alternative) }
    })).filter(u => u.name)
  })).filter(t => t.exercises.length);
  if (!daysArr.length) return false;
  const days = daysArr.length;
  db.plan = {
    name: str(r.name) || 'Dein Plan', goal: meta.goal, daysPerWeek: days, level: meta.level, time: meta.time, notes: meta.notes, start: meta.start, days: daysArr,
    weeks: Math.max(4, Math.min(16, num(r.wochen) || 10)),
    phases: (r.phasen || []).map(p => ({ weeks: str(p.wochen), title: str(p.titel), note: str(p.hinweis) })).filter(p => p.weeks),
    warmup: str(r.aufwaermen), cardio: str(r.ausdauer), tips: arr(r.ernaehrung), createdAt: Date.now()
  };
  if (db.settings.trainDays.length !== days) {
    db.settings.trainDays = defaultTrainDays(days);
    scheduleTraining(db.settings.trainDays, db.settings.trainTime, db.settings.remind).catch(() => {});
  }
  planSel = 0; restTotal = 0; $('#plan-setup').open = false; $('#p-hint').textContent = '';
  save(); toast('Trainingsplan gespeichert');
  $('#plan-view').scrollIntoView({ behavior: 'smooth' });
  return true;
}

export function initTraining() {
  $('#p-start').value = today();
  $('#w-ex').addEventListener('input', () => { pendingPlanDay = null; exHint(); });
  $('#w-ex').addEventListener('change', () => {
    const prev = lastOf($('#w-ex').value.trim());
    if (prev) { $('#w-sets').value = prev.sets; $('#w-reps').value = prev.reps; $('#w-kg').value = prev.kg ? String(prev.kg).replace('.', ',') : ''; }
  });
  $('#w-mic').onclick = voiceWorkout;
  $('#pform').onsubmit = createPlan;
  $('#wform').onsubmit = e => {
    e.preventDefault();
    const ex = $('#w-ex').value.trim(); if (!ex) return;
    const plan = db.plan; let pd = pendingPlanDay;
    if (pd == null && plan) { const i = planSel ?? autoPlanDay(plan); if (plan.days[i]?.exercises.some(x => x.name.toLowerCase() === ex.toLowerCase())) pd = i; }
    const w = { id: uid(), at: Date.now(), date: S.day, ex, sets: num($('#w-sets').value) || 1, reps: num($('#w-reps').value) || 1, kg: num($('#w-kg').value) || 0 };
    if (pd != null) w.planDay = pd;
    if (plan && isDeload(planPhase(plan, planWeek(plan)))) w.deload = true;
    db.workouts.push(w); pendingPlanDay = null;
    $('#w-ex').value = ''; $('#w-kg').value = '';
    save(); toast('Eingetragen');
    if (plan) $('#plan-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  addRender(() => { renderPlan(); renderRest(); renderLog(); });
}
