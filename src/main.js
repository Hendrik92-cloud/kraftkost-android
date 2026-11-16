import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import { App } from '@capacitor/app';
import { db, load, onChange, flush, save } from './store.js';
import { S, renderAll } from './app.js';
import { $, $$, today, addDays, fmtDay } from './util.js';
import { isNative, tap } from './native.js';
import { initTraining, resetPlanSel } from './training.js';
import { initEssen } from './essen.js';
import { initPlan } from './plan.js';
import { initEinkauf } from './einkauf.js';
import { initMehr, showMore } from './mehr.js';
import { initNotes } from './notes.js';
import { startSync, connected, pull } from './sync.js';

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

async function boot() {
  await load();
  initTraining(); initEssen(); initPlan(); initEinkauf(); initNotes(); initMehr();
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
  showTab('training', false);
  setDay(today());
}

boot();
