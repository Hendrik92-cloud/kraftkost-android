import { App } from '@capacitor/app';
import { db, load, onChange, flush } from './store.js';
import { S, renderAll } from './app.js';
import { $, $$, today, addDays, fmtDay } from './util.js';
import { isNative, tap } from './native.js';
import { initTraining, resetPlanSel } from './training.js';
import { initEssen } from './essen.js';
import { initPlan } from './plan.js';
import { initEinkauf } from './einkauf.js';
import { initMehr, showMore } from './mehr.js';

const TABS = ['training', 'essen', 'plan', 'einkauf', 'mehr'];
const history = [];

function showTab(t, push = true) {
  if (!TABS.includes(t)) t = 'training';
  if (push && S.tab !== t) history.push(S.tab);
  S.tab = t;
  TABS.forEach(x => ($('#tab-' + x).hidden = x !== t));
  $$('nav.tabs button').forEach(b => (b.dataset.tab === t ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  $('#daynav').hidden = !(t === 'training' || t === 'essen');
  window.scrollTo(0, 0);
}

function setDay(d) {
  S.day = d; resetPlanSel();
  const t = today();
  $('#daylabel').textContent = d === t ? 'Heute' : fmtDay(d);
  $('#todaybtn').hidden = d === t;
  $('#nextday').disabled = d >= t;
  renderAll();
}

async function boot() {
  await load();
  initTraining(); initEssen(); initPlan(); initEinkauf(); initMehr();
  onChange(renderAll);

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
    App.addListener('resume', () => { if (S.day < today() && $('#todaybtn').hidden) setDay(today()); else renderAll(); });
    App.addListener('backButton', () => {
      const open = document.querySelector('details[open]');
      if (history.length) showTab(history.pop(), false);
      else if (open && open.id) open.open = false;
      else App.minimizeApp();
    });
  }

  showTab(db.settings.apiKey ? 'training' : 'mehr', false);
  if (!db.settings.apiKey) showMore('einstellungen');
  setDay(today());
}

boot();
