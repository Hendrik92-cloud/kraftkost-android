/* Nahrungsergänzung: tägliche Abhakliste und Erinnerung morgens/abends. */
import { db, save } from './store.js';
import { S, addRender } from './app.js';
import { $, $$, esc, uid, today, toast, armed } from './util.js';
import { scheduleSupps, setAlarm } from './native.js';

const WHEN = { morgens: 'Morgens', abends: 'Abends' };
const byWhen = k => db.settings.supps.filter(x => x.when === k);

export function rescheduleSupps(hintEl) {
  const s = db.settings;
  return scheduleSupps({ morgens: byWhen('morgens').map(x => x.name), abends: byWhen('abends').map(x => x.name), times: s.suppTimes, on: s.suppRemind })
    .then(ok => { if (hintEl && ok && s.suppRemind && s.supps.length) hintEl.textContent = `Erinnerung täglich um ${s.suppTimes.morgens} und ${s.suppTimes.abends} Uhr.`; })
    .catch(e => { if (hintEl) hintEl.textContent = e.message; });
}

/** Karte „Ergänzungen heute“ im Essen-Tab: antippen = genommen. */
function renderToday() {
  const box = $('#sp-today'); const s = db.settings;
  if (!s.supps.length) { box.hidden = true; return; }
  box.hidden = false;
  const taken = new Set(db.suppLog[S.day] || []);
  const done = s.supps.filter(x => taken.has(x.id)).length;
  box.innerHTML = `<div class="actions between"><h3>Ergänzungen ${S.day === today() ? 'heute' : ''}</h3><span class="small muted">${done} von ${s.supps.length}</span></div>` +
    ['morgens', 'abends'].filter(k => byWhen(k).length).map(k => `<div class="supprow"><span class="small muted">${WHEN[k]} · ${s.suppTimes[k]}</span><div class="filter">${byWhen(k).map(x => `<button type="button" data-sp="${x.id}" aria-pressed="${taken.has(x.id)}">${taken.has(x.id) ? '✓ ' : ''}${esc(x.name)}</button>`).join('')}</div></div>`).join('');
  box.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => {
    const l = new Set(db.suppLog[S.day] || []); const id = b.dataset.sp;
    l.has(id) ? l.delete(id) : l.add(id);
    db.suppLog[S.day] = [...l];
    // Alte Einträge nach 60 Tagen aufräumen
    const cut = new Date(); cut.setDate(cut.getDate() - 60); const c = cut.toISOString().slice(0, 10);
    Object.keys(db.suppLog).forEach(d => { if (d < c) delete db.suppLog[d]; });
    save();
  });
}

function renderSettings() {
  const box = $('#sp-list'); if (box.contains(document.activeElement)) return;
  const s = db.settings;
  if (document.activeElement !== $('#sp-morning')) $('#sp-morning').value = s.suppTimes.morgens;
  if (document.activeElement !== $('#sp-evening')) $('#sp-evening').value = s.suppTimes.abends;
  $('#sp-remind').checked = s.suppRemind;
  box.innerHTML = s.supps.length ? s.supps.map((x, i) => `<div class="row wide" style="align-items:end">
      <label for="sp-n${i}">Mittel<input id="sp-n${i}" data-spi="${i}" data-k="name" value="${esc(x.name)}"></label>
      <label for="sp-w${i}">Wann<select id="sp-w${i}" data-spi="${i}" data-k="when">${Object.entries(WHEN).map(([k, v]) => `<option value="${k}" ${x.when === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <button type="button" class="del" data-spdel="${i}" style="grid-column:1/-1;justify-self:start">Entfernen</button></div>`).join('')
    : '<p class="small muted">Noch nichts eingetragen.</p>';
  box.querySelectorAll('[data-spi]').forEach(el => el.onchange = () => { s.supps[+el.dataset.spi][el.dataset.k] = el.value.trim(); save(); rescheduleSupps($('#sp-hint')); });
  box.querySelectorAll('[data-spdel]').forEach(b => b.onclick = () => { if (!armed(b)) return; s.supps.splice(+b.dataset.spdel, 1); box.innerHTML = ''; save(); rescheduleSupps($('#sp-hint')); });
}

export function initSupps() {
  const s = () => db.settings;
  $('#sp-add').onclick = () => { s().supps.push({ id: uid(), name: '', when: 'abends' }); $('#sp-list').innerHTML = ''; save(); };
  $('#sp-morning').onchange = () => { s().suppTimes.morgens = $('#sp-morning').value || '07:00'; save(); rescheduleSupps($('#sp-hint')); };
  $('#sp-evening').onchange = () => { s().suppTimes.abends = $('#sp-evening').value || '21:00'; save(); rescheduleSupps($('#sp-hint')); };
  $('#sp-remind').onchange = () => { s().suppRemind = $('#sp-remind').checked; save(); rescheduleSupps($('#sp-hint')); };
  $('#sp-alarm').onclick = async () => {
    // Zwei Wecker in der Uhr-App, jeden Tag
    const all = [1, 2, 3, 4, 5, 6, 7];
    try {
      for (const k of ['morgens', 'abends']) {
        if (!byWhen(k).length) continue;
        const [h, m] = s().suppTimes[k].split(':').map(Number);
        await setAlarm({ hour: h, minute: m, message: byWhen(k).map(x => x.name).join(', '), days: all });
      }
      $('#sp-hint').textContent = 'Wecker in der Uhr-App gestellt.';
    } catch (e) { $('#sp-hint').textContent = e.message; }
  };
  addRender(() => { renderToday(); renderSettings(); });
}

/** Für die Übernahme aus dem Chat. */
export function applySupps(e) {
  if (!e) return false;
  const s = db.settings;
  if (/^\d{1,2}:\d{2}$/.test(e.morgens || '')) s.suppTimes.morgens = e.morgens.padStart(5, '0');
  if (/^\d{1,2}:\d{2}$/.test(e.abends || '')) s.suppTimes.abends = e.abends.padStart(5, '0');
  for (const x of e.liste || []) {
    if (!x.name || s.supps.some(y => y.name.toLowerCase() === String(x.name).toLowerCase())) continue;
    s.supps.push({ id: uid(), name: String(x.name), when: x.wann === 'morgens' ? 'morgens' : 'abends' });
  }
  if (e.erinnern != null) s.suppRemind = !!e.erinnern;
  rescheduleSupps();
  return true;
}
