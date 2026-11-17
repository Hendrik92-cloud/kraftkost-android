import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import { App } from '@capacitor/app';
import { db, load, onChange, flush, save } from './store.js';
import { S, renderAll } from './app.js';
import { $, $$, esc, today, addDays, fmtDay } from './util.js';
import { isNative, tap } from './native.js';
import { initTraining, resetPlanSel } from './training.js';
import { initEssen } from './essen.js';
import { initPlan } from './plan.js';
import { initEinkauf } from './einkauf.js';
import { initMehr, showMore } from './mehr.js';
import { initNotes } from './notes.js';
import { initImporter, importAny } from './importer.js';
import { initSupps } from './supps.js';
const presets = import.meta.glob('./presets/*.json', { eager: true });
import { toast } from './util.js';
import { startSync, connected, pull } from './sync.js';
import { startUpdates, initUpdateCard } from './update.js';
import { pollJobs } from './claude.js';
import { initMealRemind } from './mealremind.js';
import { scheduleTraining, scheduleSupps } from './native.js';
import { startHealth } from './health.js';
import { LocalNotifications } from '@capacitor/local-notifications';

const TABS = ['training', 'essen', 'plan', 'einkauf', 'notizen', 'mehr'];
const history = [];

function showTab(t, push = true) {
  if (!TABS.includes(t)) t = 'training';
  if (push && S.tab !== t) history.push(S.tab);
  S.tab = t;
  TABS.forEach(x => ($('#tab-' + x).hidden = x !== t));
  $$('nav.tabs button').forEach(b => (b.dataset.tab === t ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  $('#daynav').hidden = !(t === 'training' || t === 'essen');
  $('#gear').style.color = t === 'mehr' ? 'var(--accent)' : '';
  window.scrollTo(0, 0);
  if ((t === 'einkauf' || t === 'plan') && connected()) pull();
}

function setDay(d) {
  S.day = d; resetPlanSel();
  const t = today();
  $('#todaydate').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#daylabel').textContent = d === t ? 'Heute' : fmtDay(d);
  $('#todaybtn').hidden = d === t;
  $('#nextday').disabled = d >= t;
  renderAll();
}

/**
 * Im Chat vorbereitete Pakete (Pläne, Ziele, Erinnerungen) zur Übernahme anbieten.
 * Mit Auswahl, damit auf einem zweiten Handy nur Passendes übernommen wird.
 */
function showPresets() {
  const applied = new Set(db.settings.presetsApplied || (db.settings.presetApplied ? [db.settings.presetApplied] : []));
  const pending = Object.entries(presets).sort(([a], [b]) => a.localeCompare(b)).map(([, m]) => m.default || m).filter(p => p?.id && !applied.has(p.id));
  const box = $('#presets');
  if (!pending.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<h3>Neu aus dem Claude-Chat</h3>
    <p class="small muted">Auf einem zweiten Handy nur auswählen, was für diese Person passt.</p>
    <div class="stack" style="gap:10px">${pending.map((p, i) => `<label class="plain" for="pr-${i}" style="align-items:flex-start"><input type="checkbox" id="pr-${i}" data-pr="${i}" checked><span><b>${esc(p.titel || p.id)}</b>${p.beschreibung ? `<br><span class="small muted">${esc(p.beschreibung)}</span>` : ''}</span></label>`).join('')}</div>
    <div class="actions"><button type="button" class="primary" id="pr-ok">Übernehmen</button><button type="button" class="ghost" id="pr-no">Nichts davon</button></div>`;
  const finish = chosen => {
    const news = [];
    pending.forEach((p, i) => { if (chosen.includes(i)) { const w = importAny(p); if (w) news.push(w); } applied.add(p.id); });
    db.settings.presetsApplied = [...applied]; box.hidden = true; save();
    toast(news.length ? 'Übernommen: ' + news.join(', ') : 'Nichts übernommen');
  };
  $('#pr-ok').onclick = () => finish(pending.map((_, i) => i).filter(i => $('#pr-' + i).checked));
  $('#pr-no').onclick = () => finish([]);
}

async function boot() {
  await load();
  if (await startUpdates()) return;
  initTraining(); initEssen(); initPlan(); initEinkauf(); initNotes(); initMehr(); initImporter(); initSupps(); initUpdateCard(); initMealRemind();
  onChange(renderAll);
  startSync(() => S.tab === 'einkauf' || S.tab === 'plan');
  $('#gear').onclick = () => { tap(); showTab('mehr'); };

  $$('nav.tabs button').forEach(b => (b.onclick = () => { tap(); showTab(b.dataset.tab); }));
  $('#prevday').onclick = () => setDay(addDays(S.day, -1));
  $('#nextday').onclick = () => setDay(addDays(S.day, 1));
  $('#todaybtn').onclick = () => setDay(today());
  document.addEventListener('click', e => {
    const g = e.target.closest('[data-goto]'); if (!g) return;
    showTab('mehr'); showMore(g.dataset.goto);
  });

  if (isNative) {
    App.addListener('pause', () => flush());
    // Nach Mitternacht wieder auf „Heute“ springen, wenn vorher „Heute“ offen war.
    App.addListener('resume', () => { if (S.day < today() && $('#todaybtn').hidden) setDay(today()); else renderAll(); if (connected()) pull(); });
    App.addListener('backButton', () => {
      const open = document.querySelector('details[open]');
      if (history.length) showTab(history.pop(), false);
      else if (open && open.id) open.open = false;
      else App.minimizeApp();
    });
  }

  $('#nokey-ok').onclick = () => { db.settings.keyNoticeSeen = true; save(); };
  // Pläne, die Claude im Hintergrund fertig macht, abholen.
  window.addEventListener('kk-job', e => {
    const name = e.detail.kind === 'wochenplan' ? 'Wochenplan' : 'Trainingsplan';
    toast(e.detail.ok ? `✓ ${name} ist fertig` : `${name} kam unvollständig an. Bitte nochmal erstellen.`);
    renderAll();
  });
  pollJobs();
  startHealth();
  // Erinnerungen bei jedem Start und Zurückkehren erneuern (14 Tage im Voraus, still ohne Nachfrage).
  const refreshReminders = () => {
    const st = db.settings; const by = k => st.supps.filter(x => x.when === k).map(x => x.name);
    scheduleTraining(st.trainDays, st.trainTime, st.remind, false).catch(() => {});
    scheduleSupps({ morgens: by('morgens'), abends: by('abends'), times: st.suppTimes, on: st.suppRemind }, false).catch(() => {});
  };
  refreshReminders();
  if (isNative) App.addListener('resume', refreshReminders);
  // Tipp auf eine Mahlzeiten-Erinnerung öffnet direkt „Essen“.
  if (isNative) LocalNotifications.addListener('localNotificationActionPerformed', e => { const t = e.notification?.extra?.tab; if (t) showTab(t); });
  if (isNative) App.addListener('resume', () => pollJobs());

  showPresets();
  showTab('training', false);
  setDay(today());
}

boot();
