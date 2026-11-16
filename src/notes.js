import { db, save } from './store.js';
import { addRender, busy } from './app.js';
import { $, $$, esc, uid, toast, armed } from './util.js';
import { askJSON, aiMsg, hasKey } from './claude.js';
import { listen, sendMail } from './native.js';
import { showBridge } from './bridge.js';

let target = '', filter = 'Alle', editId = null, compose = null;
const companies = () => db.settings.companies || [];
const compOf = id => companies().find(c => c.id === id);
const fmtWhen = ts => new Date(ts).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function renderTargets() {
  const C = companies();
  if (target && !compOf(target)) target = '';
  $('#n-to').innerHTML = [['', 'Privat'], ...C.map(c => [c.id, c.name])].map(([id, n]) => `<button type="button" data-nt="${id}" aria-pressed="${target === id}">${esc(n)}</button>`).join('') +
    (C.length ? '' : '<button type="button" class="ghost" data-goto="einstellungen">+ Firma anlegen</button>');
  $$('[data-nt]').forEach(b => b.onclick = () => { target = b.dataset.nt; renderTargets(); });
  $('#n-savesend').hidden = !target;
}

function renderList() {
  const C = companies();
  const F = { Alle: () => true, Offen: n => n.company && !n.sentAt, Privat: n => !n.company };
  C.forEach(c => { F[c.name] = n => n.company === c.id; });
  if (!F[filter]) filter = 'Alle';
  $('#n-filter').innerHTML = Object.keys(F).map(k => `<button type="button" data-nf="${esc(k)}" aria-pressed="${filter === k}">${esc(k)} (${db.notes.filter(F[k]).length})</button>`).join('');
  $$('[data-nf]').forEach(b => b.onclick = () => { filter = b.dataset.nf; renderList(); });
  const xs = [...db.notes].filter(F[filter]).sort((a, b) => b.at - a.at);
  // Sammelmail: alle offenen Notizen einer Firma auf einmal
  const comp = C.find(c => c.name === filter);
  const openOfComp = comp ? xs.filter(n => !n.sentAt) : [];
  const bulk = openOfComp.length > 1 ? `<div class="actions"><button type="button" class="primary" data-bulk="${comp.id}">Alle ${openOfComp.length} offenen an ${esc(comp.name)} mailen</button></div>` : '';
  if (!xs.length) { $('#n-list').innerHTML = `<div class="empty">${db.notes.length ? 'Hier ist noch nichts.' : 'Noch keine Notizen. Tipp oben aufs Mikrofon und sprich einfach drauflos. Gehört der Gedanke zu einer Firma, wähl sie aus und schick ihn gleich per Mail.'}</div>`; return; }
  $('#n-list').innerHTML = bulk + '<div class="list">' + xs.map(n => {
    const c = compOf(n.company);
    return `<div class="item" style="align-items:flex-start"><div class="main">
      <div class="note-text">${esc(n.text)}</div>
      <div class="chips">${c ? `<span class="chip t">${esc(c.name)}</span>` : '<span class="chip mute">Privat</span>'}${n.sentAt ? `<span class="chip mute">gemailt ${fmtWhen(n.sentAt)}</span>` : c ? '<span class="chip">offen</span>' : ''}<span class="s">${fmtWhen(n.at)}</span></div>
      <div class="actions" style="margin-top:8px">${c ? `<button type="button" class="sm" data-nmail="${n.id}">Mailen</button>` : ''}<button type="button" class="sm ghost" data-nedit="${n.id}">Bearbeiten</button><button type="button" class="del" data-ndel="${n.id}">Entfernen</button></div>
    </div></div>`;
  }).join('') + '</div>';
  $$('[data-nmail]').forEach(b => b.onclick = () => openCompose([db.notes.find(n => n.id === b.dataset.nmail)]));
  $$('[data-bulk]').forEach(b => b.onclick = () => openCompose(openOfComp));
  $$('[data-nedit]').forEach(b => b.onclick = () => {
    const n = db.notes.find(x => x.id === b.dataset.nedit); if (!n) return;
    editId = n.id; $('#n-text').value = n.text; target = n.company || ''; renderTargets();
    $('#n-save').textContent = 'Änderung speichern'; $('#nform').scrollIntoView({ behavior: 'smooth' }); $('#n-text').focus();
  });
  $$('[data-ndel]').forEach(b => b.onclick = () => { if (!armed(b)) return; db.notes = db.notes.filter(n => n.id !== b.dataset.ndel); save(); });
}

/* ---------- Mail ---------- */
function draftFrom(notes) {
  if (notes.length === 1) {
    const t = notes[0].text.trim(); const first = t.split(/[\n.!?]/)[0].trim();
    return { subject: first.length > 70 ? first.slice(0, 67) + '…' : first, body: t };
  }
  return { subject: `${notes.length} Punkte von mir`, body: 'Hallo,\n\nhier ein paar Punkte, die mir eingefallen sind:\n\n' + notes.map(n => '• ' + n.text.trim().replace(/\n+/g, ' ')).join('\n') + '\n\nViele Grüße' };
}
function openCompose(notes) {
  const c = compOf(notes[0].company);
  compose = { notes, company: c, ...draftFrom(notes) };
  renderCompose();
}
function renderCompose() {
  const box = $('#n-compose');
  if (!compose) { box.innerHTML = ''; return; }
  const c = compose.company;
  box.innerHTML = `<div class="card"><div class="actions between"><h3>Mail an ${esc(c?.name || '')}</h3><button type="button" class="sm ghost" id="nc-x">Schließen</button></div>
    <p class="small muted">An: ${esc(c?.email || 'keine Adresse hinterlegt')}</p>
    <label for="nc-sub">Betreff<input id="nc-sub" value="${esc(compose.subject)}"></label>
    <label for="nc-body">Text<textarea id="nc-body" rows="8">${esc(compose.body)}</textarea></label>
    <div class="actions"><button type="button" class="primary" id="nc-send">In Mail-App öffnen</button><button type="button" id="nc-ai">Mit Claude ausformulieren</button></div>
    <p class="hint" id="nc-hint"></p><div id="nc-bridge"></div></div>`;
  const read = () => { compose.subject = $('#nc-sub').value; compose.body = $('#nc-body').value; };
  $('#nc-x').onclick = () => { compose = null; renderCompose(); };
  $('#nc-send').onclick = async () => {
    read();
    try {
      await sendMail(c?.email || '', compose.subject, compose.body);
      const now = Date.now(); compose.notes.forEach(n => { n.sentAt = now; });
      compose = null; save(); renderCompose(); toast('An die Mail-App übergeben');
    } catch (e) { $('#nc-hint').textContent = e.message || 'Keine Mail-App gefunden.'; }
  };
  $('#nc-ai').onclick = async () => {
    read();
    const prompt = `Formuliere aus diesen spontanen Notizen eine kurze, klare geschäftliche E-Mail auf Deutsch an ${c?.name || 'die Firma'}. Ich schreibe sie selbst an diese Adresse (${c?.email || ''}), es sind meine eigenen Gedanken und Aufgaben. Locker-professionell, Du oder Sie so wie in den Notizen erkennbar, sonst neutral. Punkte als kurze Liste, wenn es mehrere sind. Nichts erfinden.
Notizen:
${compose.notes.map(n => '- ' + n.text).join('\n')}
Form: {"betreff":"…","text":"…"}`;
    const apply = r => { if (!r.text) return false; compose.subject = String(r.betreff || compose.subject); compose.body = String(r.text); renderCompose(); return true; };
    if (!hasKey()) { showBridge($('#nc-bridge'), prompt, apply); return; }
    await busy($('#nc-ai'), $('#nc-hint'), 'Claude formuliert …', async () => {
      try { if (!apply(await askJSON(prompt, { maxTokens: 1500 }))) throw new Error(); }
      catch (e) { $('#nc-hint').textContent = e.code ? aiMsg(e) : 'Das hat nicht geklappt.'; }
    });
  };
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Erfassen ---------- */
function saveNote(andSend) {
  const text = $('#n-text').value.trim(); if (!text) { $('#n-text').focus(); return; }
  let n;
  if (editId) { n = db.notes.find(x => x.id === editId); if (n) Object.assign(n, { text, company: target || null }); }
  else { n = { id: uid(), at: Date.now(), text, company: target || null, sentAt: null }; db.notes.push(n); }
  editId = null; $('#n-text').value = ''; $('#n-save').textContent = 'Speichern'; $('#n-hint').textContent = '';
  save(); toast('Notiz gespeichert');
  if (andSend && n?.company) openCompose([n]);
}

export function initNotes() {
  $('#n-mic').onclick = async () => {
    try {
      const t = await listen('Sprich deine Notiz');
      if (!t) return;
      const ta = $('#n-text'); ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + t.charAt(0).toUpperCase() + t.slice(1);
      $('#n-hint').textContent = 'Nochmal aufs Mikrofon tippen, um weiterzusprechen.';
    } catch (e) { toast(e.message); }
  };
  $('#nform').onsubmit = e => { e.preventDefault(); saveNote(false); };
  $('#n-savesend').onclick = () => saveNote(true);
  addRender(() => { renderTargets(); renderList(); });
}
