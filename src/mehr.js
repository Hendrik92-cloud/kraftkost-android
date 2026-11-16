import JSZip from 'jszip';
import { db, save, saveImage, readImage, deleteImage, replaceAll, flush } from './store.js';
import { S, addRender, busy } from './app.js';
import { $, $$, esc, de, num, uid, eur, today, addDays, addYears, daysUntil, fmtDay, fmtDate, fmtShort, toast, armed, WD } from './util.js';
import { ask, askJSON, aiMsg } from './claude.js';
import { takePhoto, shareFile, shareText, scheduleTraining, scheduleWarranty, addCalendar, setAlarm, isNative } from './native.js';
import { connected, getStatus, onStatus, createHousehold, joinHousehold, inviteCode, syncNow, disconnect } from './sync.js';
import { copy, paste } from './bridge.js';
import setupSQL from '../supabase/setup.sql?raw';

/* ================= Gewicht ================= */
function renderWeight() {
  const K = [...db.weights].sort((a, b) => a.date.localeCompare(b.date));
  const last = K[K.length - 1];
  const ref = last && [...K].reverse().find(k => k.date <= addDays(last.date, -30));
  const first = K[0];
  const d = (a, b) => { const v = a - b; return (v > 0 ? '+' : v < 0 ? '−' : '±') + de(Math.abs(v), 1); };
  $('#k-stats').innerHTML = `<div class="stat"><b>${last ? de(last.kg, 1) : '–'}</b><span>Aktuell kg</span></div><div class="stat"><b>${last && ref ? d(last.kg, ref.kg) : '–'}</b><span>30 Tage</span></div><div class="stat"><b>${last && first && first !== last ? d(last.kg, first.kg) : '–'}</b><span>Gesamt</span></div>`;
  $('#k-chart').innerHTML = '<h3>Verlauf</h3>' + chart(K.slice(-90));
  if (!K.length) { $('#k-list').innerHTML = '<div class="empty">Noch kein Gewicht eingetragen. Am besten morgens, immer zur gleichen Zeit.</div>'; return; }
  const rows = [...K].reverse().slice(0, 30);
  $('#k-list').innerHTML = '<div class="list">' + rows.map((k, i) => { const p = rows[i + 1]; return `<div class="item"><div class="main"><div class="t num">${de(k.kg, 1)} kg</div><div class="s">${fmtDay(k.date)}${p ? ` · ${d(k.kg, p.kg)} kg` : ''}</div></div><button type="button" class="del" data-kdel="${k.id}">Entfernen</button></div>`; }).join('') + '</div>';
  $$('[data-kdel]').forEach(b => b.onclick = () => { if (!armed(b)) return; db.weights = db.weights.filter(w => w.id !== b.dataset.kdel); save(); });
}
function chart(pts) {
  if (pts.length < 2) return '<p class="small muted">Ab zwei Einträgen siehst du hier deinen Verlauf.</p>';
  const W = 340, H = 180, pl = 34, pr = 14, pt = 14, pb = 26;
  const t = pts.map(p => new Date(p.date + 'T12:00').getTime()), kg = pts.map(p => p.kg);
  const mn = Math.min(...kg), mx = Math.max(...kg), rng = mx - mn;
  const step = rng <= 3 ? 1 : rng <= 8 ? 2 : rng <= 20 ? 5 : 10;
  const lo = Math.floor((mn - step * 0.3) / step) * step, hi = Math.ceil((mx + step * 0.3) / step) * step;
  const t0 = t[0], t1 = t[t.length - 1];
  const x = i => pl + (t1 === t0 ? 0.5 : (t[i] - t0) / (t1 - t0)) * (W - pl - pr);
  const y = v => pt + (hi - v) / (hi - lo) * (H - pt - pb);
  let g = '';
  for (let v = lo; v <= hi + 1e-9; v += step) g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}</text>`;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.kg).toFixed(1)}`).join('');
  const area = line + `L${x(pts.length - 1).toFixed(1)},${y(lo)}L${x(0).toFixed(1)},${y(lo)}Z`;
  const li = pts.length - 1;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewichtsverlauf">${g}<path d="${area}" fill="var(--accent-soft)"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/><circle cx="${x(li)}" cy="${y(pts[li].kg)}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/><text x="${pl}" y="${H - 8}" font-size="11" fill="var(--muted)">${fmtShort(pts[0].date)}</text><text x="${W - pr}" y="${H - 8}" font-size="11" fill="var(--muted)" text-anchor="end">${fmtShort(pts[li].date)}</text></svg>`;
}

/* ================= Belege ================= */
const CATS = { steuer: 'Steuer', garantie: 'Garantie', beides: 'Steuer + Garantie', privat: 'Privat' };
const TAX = { arbeitsmittel: 'Arbeitsmittel / Werbungskosten', handwerker: 'Handwerker / Haushaltsnahe Dienste', krankheit: 'Krankheitskosten', spende: 'Spende', versicherung: 'Versicherung / Vorsorge', sonstiges: 'Sonstiges' };
const isTax = c => c === 'steuer' || c === 'beides', isWar = c => c === 'garantie' || c === 'beides';
const opts = (o, s) => Object.entries(o).map(([k, v]) => `<option value="${k}" ${k === s ? 'selected' : ''}>${v}</option>`).join('');
const priceStr = v => (v === '' || v == null ? '' : esc(String(v).replace('.', ',')));
let draft = null, rFilter = 'Alle', openId = null;
const imgCache = {};

async function newReceipt() {
  let img;
  try { img = await takePhoto(); } catch (e) { toast(e.message); return; }
  if (!img) return;
  draft = { img, store: '', date: today(), total: '', items: [], cat: 'privat', tax: 'sonstiges', product: '', warranty: '', note: '', status: 'Claude liest den Beleg …' };
  renderDraft(); $('#r-draft').scrollIntoView({ behavior: 'smooth' });
  try {
    const r = await askJSON(`Das Bild zeigt einen Kassenbon oder eine Rechnung aus Deutschland. Lies ihn vollständig aus.
Schätze außerdem ein, wofür er aufbewahrt werden sollte:
- "garantie", wenn ein langlebiges Produkt gekauft wurde (Elektronik, Haushaltsgerät, Werkzeug, Möbel, Kleidung über 50 €).
- "steuer", wenn er für die Einkommensteuer relevant sein könnte (Arbeitsmittel, Fachliteratur, Handwerker- oder Haushaltsdienste, Arzt oder Apotheke mit Zuzahlung, Spende, Versicherung).
- "beides", wenn beides zutrifft (z. B. Laptop oder Werkzeug für die Arbeit), sonst "privat".
Form: {"laden":"…","datum":"YYYY-MM-DD oder leer","summe":12.34,"positionen":[{"name":"…","preis":1.99}],"kategorie":"steuer|garantie|beides|privat","steuerart":"arbeitsmittel|handwerker|krankheit|spende|versicherung|sonstiges","produkt":"Hauptprodukt bei Garantie, sonst leer","garantie_jahre":2}
Preise als Zahl in Euro. Pfand und Rabatte als eigene Positionen, Rabatte negativ. Wenn das Bild kein Beleg ist: {"fehler":"kurzer Grund"}.`, { smart: true, images: [img], maxTokens: 3000 });
    if (!draft) return; readDraft();
    if (r.fehler) draft.status = 'Kein Beleg erkannt: ' + r.fehler + ' Du kannst die Angaben selbst eintragen.';
    else {
      const d = draft; d.store = r.laden || ''; if (/^\d{4}-\d{2}-\d{2}$/.test(r.datum || '')) d.date = r.datum; d.total = num(r.summe) ?? '';
      d.items = (Array.isArray(r.positionen) ? r.positionen : []).map(p => ({ name: String(p.name || ''), price: num(p.preis) }));
      if (CATS[r.kategorie]) d.cat = r.kategorie; if (TAX[r.steuerart]) d.tax = r.steuerart; d.product = r.produkt || '';
      if (isWar(d.cat)) d.warranty = addYears(d.date, Math.max(1, Math.min(10, num(r.garantie_jahre) || 2)));
      d.status = 'Ausgelesen. Prüf die Angaben, vor allem die Kategorie, und speichere.';
    }
  } catch (e) { if (!draft) return; readDraft(); draft.status = aiMsg(e) + ' Du kannst die Angaben auch selbst eintragen.'; }
  renderDraft();
}
function readDraft() {
  const d = draft; if (!d || !$('#d-store')) return;
  d.store = $('#d-store').value; d.date = $('#d-date').value; d.total = $('#d-total').value; d.cat = $('#d-cat').value; d.tax = $('#d-tax').value;
  d.product = $('#d-product').value; d.warranty = $('#d-war').value; d.note = $('#d-note').value;
  d.items = $$('.irow').map(r => ({ name: r.querySelector('.in').value, price: r.querySelector('.ip').value }));
}
function syncCat() {
  const c = $('#d-cat').value; $('#d-tax-row').hidden = !isTax(c); $('#d-war-row').hidden = !isWar(c);
  if (isWar(c) && !$('#d-war').value) $('#d-war').value = addYears($('#d-date').value || today(), 2);
}
function renderDraft() {
  const d = draft; const box = $('#r-draft'); if (!d) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card"><img class="preview" src="data:image/jpeg;base64,${d.img}" alt="Foto des Belegs"><p class="hint">${esc(d.status)}</p>
  <div class="row"><label for="d-store">Laden<input id="d-store" value="${esc(d.store)}"></label><label for="d-date">Datum<input id="d-date" type="date" value="${esc(d.date)}"></label><label for="d-total">Summe €<input id="d-total" inputmode="decimal" value="${priceStr(d.total)}"></label></div>
  <label for="d-cat">Aufbewahren für<select id="d-cat">${opts(CATS, d.cat)}</select></label>
  <div id="d-tax-row"><label for="d-tax">Steuer-Art<select id="d-tax">${opts(TAX, d.tax)}</select></label></div>
  <div class="row" id="d-war-row"><label for="d-product">Produkt<input id="d-product" value="${esc(d.product)}" placeholder="z. B. Waschmaschine"></label><label for="d-war">Garantie bis<input id="d-war" type="date" value="${esc(d.warranty)}"></label></div>
  <label for="d-note">Notiz<input id="d-note" value="${esc(d.note)}" placeholder="optional"></label>
  <details><summary>Positionen (${d.items.length})</summary><div class="stack" style="gap:6px">${d.items.map((it, i) => `<div class="irow"><input class="in" aria-label="Artikel" value="${esc(it.name)}"><input class="ip" aria-label="Preis" inputmode="decimal" value="${priceStr(it.price)}"><button type="button" class="ghost icon" data-rm="${i}" aria-label="Position entfernen">×</button></div>`).join('')}
  <div class="actions"><button type="button" class="ghost sm" id="d-add">Position hinzufügen</button></div></div></details>
  <div class="actions"><button class="primary" id="d-save" type="button">Beleg speichern</button><button class="ghost" id="d-cancel" type="button">Verwerfen</button></div></div>`;
  syncCat(); $('#d-cat').onchange = syncCat;
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { readDraft(); d.items.splice(+b.dataset.rm, 1); renderDraft(); box.querySelector('details').open = true; });
  $('#d-add').onclick = () => { readDraft(); d.items.push({ name: '', price: '' }); renderDraft(); box.querySelector('details').open = true; };
  $('#d-cancel').onclick = () => { draft = null; renderDraft(); };
  $('#d-save').onclick = saveDraft;
}
async function saveDraft() {
  readDraft(); const d = draft;
  const items = d.items.filter(i => i.name.trim()).map(i => ({ name: i.name.trim(), price: num(i.price) }));
  let total = num(d.total); if (total == null && items.length) total = Math.round(items.reduce((s, i) => s + (i.price || 0), 0) * 100) / 100;
  const id = uid();
  try { await saveImage(id, d.img); } catch { toast('Foto konnte nicht gespeichert werden. Ist der Speicher voll?'); return; }
  imgCache[id] = d.img;
  db.receipts.push({ id, store: d.store.trim() || 'Beleg', date: d.date || today(), total: total || 0, items, cat: d.cat, tax: isTax(d.cat) ? d.tax : null, product: isWar(d.cat) ? d.product.trim() : '', warranty: isWar(d.cat) ? d.warranty : '', note: d.note.trim(), at: Date.now() });
  draft = null; renderDraft(); save(); syncWarranty(); toast('Beleg gespeichert');
}
function syncWarranty() {
  if (!db.settings.warrantyRemind) { scheduleWarranty([]).catch(() => {}); return; }
  const items = db.receipts.filter(r => r.warranty).map((r, i) => {
    const at = new Date(r.warranty + 'T10:00'); at.setDate(at.getDate() - 30);
    return { id: 1000 + i, title: 'Garantie läuft bald ab', body: `${r.product || r.store}: Garantie endet am ${fmtDate(r.warranty)}. Jetzt noch prüfen, ob alles funktioniert.`, at };
  });
  scheduleWarranty(items).catch(() => {});
}
function warChip(r) {
  if (!r.warranty) return ''; const n = daysUntil(r.warranty);
  if (n < 0) return '<span class="chip mute">Garantie abgelaufen</span>';
  return `<span class="chip ${n <= 60 ? 'warn' : 't'}">Garantie bis ${fmtDate(r.warranty)}</span>`;
}
function renderReceipts() {
  const R = [...db.receipts].sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
  const y = today().slice(0, 4);
  const taxSum = R.filter(r => isTax(r.cat) && r.date.startsWith(y)).reduce((s, r) => s + (r.total || 0), 0);
  const active = R.filter(r => r.warranty && daysUntil(r.warranty) >= 0);
  $('#r-stats').innerHTML = `<div class="stat"><b>${de(taxSum)} €</b><span>Steuer ${y}</span></div><div class="stat"><b>${active.length}</b><span>Garantien aktiv</span></div><div class="stat"><b>${active.filter(r => daysUntil(r.warranty) <= 60).length}</b><span>Laufen bald ab</span></div>`;
  const F = { Alle: () => true, Steuer: r => isTax(r.cat), Garantie: r => isWar(r.cat), Privat: r => !r.cat || r.cat === 'privat' };
  $('#r-filter').innerHTML = Object.keys(F).map(k => `<button type="button" data-rf="${k}" aria-pressed="${rFilter === k}">${k} (${R.filter(F[k]).length})</button>`).join('');
  $$('[data-rf]').forEach(b => b.onclick = () => { rFilter = b.dataset.rf; renderReceipts(); });
  const xs = R.filter(F[rFilter]);
  const list = $('#r-list');
  if (!R.length) { list.innerHTML = '<div class="empty">Noch keine Belege. Fotografier einen Kassenbon oder eine Rechnung. Claude liest Laden, Datum und Positionen aus und schlägt vor, ob er für Steuer oder Garantie wichtig ist.</div>'; return; }
  if (!xs.length) { list.innerHTML = '<div class="empty">In dieser Kategorie ist noch nichts.</div>'; return; }
  list.innerHTML = '<div class="list">' + xs.map(r => {
    const open = openId === r.id; const img = imgCache[r.id];
    return `<div><div class="item" data-open="${r.id}" role="button" tabindex="0" aria-expanded="${open}"><div class="main"><div class="t">${esc(r.product || r.store)}</div><div class="s">${r.product ? esc(r.store) + ' · ' : ''}${fmtDate(r.date)}</div>
      <div class="chips">${isTax(r.cat) ? `<span class="chip t">Steuer · ${esc((TAX[r.tax] || 'Sonstiges').split(' /')[0])}</span>` : ''}${warChip(r)}</div></div><span class="num">${eur(r.total)}</span></div>
      ${open ? `<div class="stack" style="padding:0 12px 14px">${img ? `<img class="preview" src="data:image/jpeg;base64,${img}" alt="Foto des Belegs">` : img === '' ? '<p class="small muted">Kein Foto gespeichert.</p>' : '<p class="small muted">Foto wird geladen …</p>'}
        ${r.note ? `<p class="small">${esc(r.note)}</p>` : ''}
        ${(r.items || []).length ? `<details><summary>Positionen (${r.items.length})</summary><div class="list">${r.items.map(i => `<div class="item"><div class="main small">${esc(i.name)}</div><span class="num small">${i.price != null ? eur(i.price) : ''}</span></div>`).join('')}</div></details>` : ''}
        <div class="row"><label for="e-cat-${r.id}">Aufbewahren für<select id="e-cat-${r.id}">${opts(CATS, r.cat || 'privat')}</select></label><label for="e-war-${r.id}">Garantie bis<input id="e-war-${r.id}" type="date" value="${esc(r.warranty || '')}"></label></div>
        <div class="actions"><button type="button" class="sm" data-esave="${r.id}">Änderung speichern</button><button type="button" class="del" data-rdel="${r.id}">Entfernen</button></div></div>` : ''}</div>`;
  }).join('') + '</div>';
  list.querySelectorAll('[data-open]').forEach(el => { const go = () => toggleReceipt(el.dataset.open); el.onclick = go; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }; });
  list.querySelectorAll('[data-esave]').forEach(b => b.onclick = () => {
    const r = db.receipts.find(x => x.id === b.dataset.esave); if (!r) return;
    const cat = $('#e-cat-' + r.id).value; let war = $('#e-war-' + r.id).value; if (isWar(cat) && !war) war = addYears(r.date, 2);
    Object.assign(r, { cat, tax: isTax(cat) ? (r.tax || 'sonstiges') : null, warranty: isWar(cat) ? war : '' });
    save(); syncWarranty(); toast('Gespeichert');
  });
  list.querySelectorAll('[data-rdel]').forEach(b => b.onclick = async () => {
    if (!armed(b)) return; const id = b.dataset.rdel;
    db.receipts = db.receipts.filter(x => x.id !== id); openId = null; await deleteImage(id); save(); syncWarranty();
  });
}
async function toggleReceipt(id) {
  openId = openId === id ? null : id; renderReceipts();
  if (openId && imgCache[id] == null) { imgCache[id] = await readImage(id); renderReceipts(); }
}

/* Steuer-Export */
function slug(s) { return String(s || 'beleg').toLowerCase().replace(/[äöüß]/g, c => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[c])).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'beleg'; }
function taxRows(y) { return db.receipts.filter(r => isTax(r.cat) && r.date.startsWith(y)).sort((a, b) => a.date.localeCompare(b.date)).map((r, i) => ({ ...r, file: `${String(i + 1).padStart(3, '0')}_${r.date}_${slug(r.store)}.jpg` })); }
function taxBy(R) { const by = {}; R.forEach(r => { const k = TAX[r.tax] || 'Sonstiges'; by[k] = (by[k] || 0) + (r.total || 0); }); return by; }
function renderTax() {
  const sel = $('#tx-year');
  const ys = [...new Set(db.receipts.filter(r => isTax(r.cat)).map(r => r.date.slice(0, 4)).concat(today().slice(0, 4)))].sort().reverse();
  const cur = ys.includes(sel.value) ? sel.value : ys[0];
  sel.innerHTML = ys.map(y => `<option ${y === cur ? 'selected' : ''}>${y}</option>`).join('');
  const R = taxRows(cur);
  $('#tx-sum').innerHTML = R.length ? '<div class="list">' + Object.entries(taxBy(R)).map(([k, v]) => `<div class="item"><div class="main"><div class="t">${esc(k)}</div></div><span class="num">${eur(v)}</span></div>`).join('') + `<div class="group-h"><span>${R.length} Belege</span><span class="num">${eur(R.reduce((s, r) => s + (r.total || 0), 0))}</span></div></div>` : '<p class="small muted">Für dieses Jahr sind noch keine Belege als Steuer markiert.</p>';
  $('#tx-csv').disabled = !R.length; $('#tx-zip').disabled = !R.length;
}
function taxCSV(R) {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"'; const c = v => (Number(v) || 0).toFixed(2).replace('.', ',');
  const L = [['Datum', 'Laden', 'Produkt', 'Steuer-Art', 'Betrag EUR', 'Notiz', 'Foto'].map(q).join(';')];
  R.forEach(r => L.push([fmtDate(r.date), r.store, r.product, TAX[r.tax] || 'Sonstiges', c(r.total), r.note, r.file].map(q).join(';')));
  L.push('', q('Summe nach Steuer-Art'));
  Object.entries(taxBy(R)).forEach(([k, v]) => L.push([q(k), '', '', '', c(v)].join(';')));
  L.push([q('Gesamt'), '', '', '', c(R.reduce((s, r) => s + (r.total || 0), 0))].join(';'));
  return '﻿' + L.join('\r\n');
}

/* ================= Einstellungen ================= */
function renderSettings() {
  const s = db.settings;
  const keep = id => document.activeElement === $(id);
  if (!keep('#st-key')) $('#st-key').value = s.apiKey;
  if (!keep('#st-mq')) $('#st-mq').value = s.modelQuick;
  if (!keep('#st-ms')) $('#st-ms').value = s.modelSmart;
  if (!keep('#st-kcal')) $('#st-kcal').value = s.kcalGoal || '';
  if (!keep('#st-prot')) $('#st-prot').value = s.proteinGoal || '';
  if (!keep('#st-plz')) $('#st-plz').value = s.plz;
  $('#st-time').value = s.trainTime; $('#st-dur').value = s.trainMinutes; $('#st-remind').checked = s.remind; $('#st-war').checked = s.warrantyRemind;
  $('#st-days').innerHTML = WD.map((d, i) => `<button type="button" data-std="${i}" aria-pressed="${s.trainDays.includes(i)}">${d}</button>`).join('');
  $$('[data-std]').forEach(b => b.onclick = () => {
    const i = +b.dataset.std; s.trainDays = s.trainDays.includes(i) ? s.trainDays.filter(x => x !== i) : s.trainDays.concat(i).sort((a, c) => a - c);
    save(); reschedule();
  });
  renderHousehold(); renderFamily(); renderCompanies();
  $('#nokey').hidden = !!s.apiKey || !!s.keyNoticeSeen;
}

/* ---------- Familie teilen ---------- */
function renderFamily() {
  const on = connected(); const st = getStatus();
  $('#fam-on').hidden = !on; $('#fam-off-box').hidden = on;
  const text = !on ? '' : st.state === 'error' ? st.msg : st.at ? `Verbunden · zuletzt abgeglichen ${st.at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'Verbunden';
  $('#fam-status').textContent = text;
  $('#fam-dot').className = 'dot ' + (st.state === 'error' ? 'err' : on ? 'ok' : '');
  $('#s-sync').textContent = on ? (st.state === 'error' ? '⚠ ' + st.msg : 'Wird mit der Familie geteilt.') : '';
}
function renderCompanies() {
  const box = $('#co-list'); if (box.contains(document.activeElement)) return;
  const C = db.settings.companies;
  box.innerHTML = C.length ? C.map((c, i) => `<div class="person">
      <label for="co-n${i}">Firma<input id="co-n${i}" data-co="${i}" data-k="name" value="${esc(c.name)}" placeholder="z. B. Firmenname"></label>
      <label for="co-e${i}">E-Mail<input id="co-e${i}" data-co="${i}" data-k="email" type="email" inputmode="email" value="${esc(c.email)}" placeholder="name@firma.de"></label>
      <div class="actions"><button type="button" class="del" data-codel="${i}">Firma entfernen</button></div></div>`).join('')
    : '<p class="small muted">Noch keine Firma angelegt.</p>';
  box.querySelectorAll('[data-co]').forEach(el => el.onchange = () => { C[+el.dataset.co][el.dataset.k] = el.value.trim(); save(); });
  box.querySelectorAll('[data-codel]').forEach(b => b.onclick = () => { if (!armed(b)) return; C.splice(+b.dataset.codel, 1); box.innerHTML = ''; save(); });
}
function renderHousehold() {
  const box = $('#hh-list'); if (box.contains(document.activeElement)) return;
  const H = db.settings.household;
  const F = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5];
  box.innerHTML = H.map((p, i) => `<div class="person">
    <div class="row wide"><label for="hh-n${i}">Name<input id="hh-n${i}" data-hh="${i}" data-k="name" value="${esc(p.name)}"></label>
    <label for="hh-f${i}">Portion<select id="hh-f${i}" data-hh="${i}" data-k="factor">${F.map(f => `<option value="${f}" ${Number(p.factor) === f ? 'selected' : ''}>${String(f).replace('.', ',')}${f === 1 ? ' (normal)' : ''}</option>`).join('')}</select></label></div>
    <div class="row"><label for="hh-k${i}">Art<select id="hh-k${i}" data-hh="${i}" data-k="kind"><option value="adult" ${p.kind !== 'child' ? 'selected' : ''}>Erwachsen</option><option value="child" ${p.kind === 'child' ? 'selected' : ''}>Kind</option></select></label>
    ${p.kind === 'child' ? `<label for="hh-a${i}">Alter<input id="hh-a${i}" data-hh="${i}" data-k="age" inputmode="numeric" value="${esc(p.age || '')}"></label>` : ''}</div>
    <label for="hh-l${i}">Mag gern<input id="hh-l${i}" data-hh="${i}" data-k="likes" value="${esc(p.likes)}" placeholder="z. B. Nudeln, Champignons"></label>
    <label for="hh-d${i}">Mag nicht / verträgt nicht<input id="hh-d${i}" data-hh="${i}" data-k="dislikes" value="${esc(p.dislikes)}" placeholder="z. B. Fisch"></label>
    ${p.id !== 'ich' ? `<div class="actions"><button type="button" class="del" data-hhdel="${i}">Person entfernen</button></div>` : '<p class="small muted">Deine Portion richtet sich nach deinen Tageszielen.</p>'}
  </div>`).join('');
  box.querySelectorAll('[data-hh]').forEach(el => el.onchange = () => {
    const p = H[+el.dataset.hh]; const k = el.dataset.k;
    p[k] = k === 'factor' ? Number(el.value) : k === 'age' ? num(el.value) : el.value.trim();
    save(); if (k === 'kind') { box.innerHTML = ''; renderHousehold(); }
  });
  box.querySelectorAll('[data-hhdel]').forEach(b => b.onclick = () => { if (!armed(b)) return; H.splice(+b.dataset.hhdel, 1); box.innerHTML = ''; save(); renderHousehold(); });
}
function reschedule() {
  const s = db.settings;
  scheduleTraining(s.trainDays, s.trainTime, s.remind).then(ok => { if (s.remind && ok) $('#st-timehint').textContent = 'Erinnerungen sind gestellt.'; })
    .catch(e => { $('#st-timehint').textContent = e.message; });
}
function nextTrainingStart() {
  const s = db.settings; const [h, m] = s.trainTime.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0);
    if (s.trainDays.includes((d.getDay() + 6) % 7) && d > new Date()) return d;
  }
  return null;
}

/* ================= Datensicherung ================= */
async function exportBackup() {
  const hint = $('#bk-hint');
  await busy($('#bk-export'), hint, 'Backup wird erstellt …', async () => {
    try {
      await flush();
      const zip = new JSZip();
      const data = JSON.parse(JSON.stringify(db)); data.settings.apiKey = '';
      zip.file('kraftkost.json', JSON.stringify(data, null, 1));
      for (const r of db.receipts) { const img = imgCache[r.id] ?? await readImage(r.id); if (img) zip.file(`belege/${r.id}.jpg`, img, { base64: true }); }
      const blob = await zip.generateAsync({ type: 'blob' });
      await shareFile(`Kraftkost-Backup_${today()}.zip`, blob, 'Kraftkost-Backup');
      hint.textContent = 'Backup erstellt. Speichere es an einem sicheren Ort.';
    } catch (e) { hint.textContent = 'Backup hat nicht geklappt: ' + (e.message || 'unbekannter Fehler'); }
  });
}
function importBackup() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.zip,application/zip,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      let data, zip = null;
      if (/\.json$/i.test(f.name)) data = JSON.parse(await f.text());
      else { zip = await JSZip.loadAsync(f); data = JSON.parse(await zip.file('kraftkost.json').async('string')); }
      if (!data || !data.settings) throw new Error();
      const n = { w: (data.workouts || []).length, m: (data.meals || []).length, r: (data.receipts || []).length };
      $('#bk-confirm').innerHTML = `<div class="notice">Backup mit ${n.w} Trainingseinträgen, ${n.m} Mahlzeiten und ${n.r} Belegen. Es ersetzt alle Daten auf diesem Handy.<div class="actions"><button type="button" class="primary sm" id="bk-yes">Ersetzen</button><button type="button" class="sm ghost" id="bk-no">Abbrechen</button></div></div>`;
      $('#bk-no').onclick = () => ($('#bk-confirm').innerHTML = '');
      $('#bk-yes').onclick = async () => {
        const key = db.settings.apiKey; data.settings.apiKey = key;
        if (zip) for (const r of data.receipts || []) { const fz = zip.file(`belege/${r.id}.jpg`); if (fz) await saveImage(r.id, await fz.async('base64')); }
        replaceAll(data); $('#bk-confirm').innerHTML = ''; reschedule(); syncWarranty(); toast('Backup eingespielt');
      };
    } catch { $('#bk-hint').textContent = 'Die Datei ist kein Kraftkost-Backup.'; }
  };
  inp.click();
}

/* ================= Navigation & Init ================= */
export function showMore(k) {
  S.more = k;
  ['gewicht', 'belege', 'einstellungen'].forEach(x => ($('#more-' + x).hidden = x !== k));
  $$('[data-more]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.more === k)));
}

export function initMehr() {
  $('#k-date').value = today();
  $('#kform').onsubmit = e => {
    e.preventDefault(); const kg = num($('#k-kg').value); if (!kg) { $('#k-kg').focus(); return; }
    const date = $('#k-date').value || today(); const ex = db.weights.find(k => k.date === date);
    if (ex) ex.kg = kg; else db.weights.push({ id: uid(), date, kg });
    $('#k-kg').value = ''; save(); toast(ex ? 'Aktualisiert' : 'Gespeichert');
  };
  $$('[data-more]').forEach(b => b.onclick = () => showMore(b.dataset.more));
  $('#r-photo').onclick = newReceipt;
  $('#tx-year').onchange = renderTax;
  $('#tx-csv').onclick = async () => { const y = $('#tx-year').value; try { await shareFile(`Steuerbelege_${y}.csv`, taxCSV(taxRows(y)), 'Steuerbelege ' + y); } catch (e) { $('#tx-hint').textContent = 'Teilen hat nicht geklappt.'; } };
  $('#tx-zip').onclick = async () => {
    const y = $('#tx-year').value; const R = taxRows(y); const hint = $('#tx-hint');
    await busy($('#tx-zip'), hint, 'Fotos werden gesammelt …', async () => {
      try {
        const zip = new JSZip(); zip.file(`Steuerbelege_${y}.csv`, taxCSV(R));
        for (const r of R) { const img = imgCache[r.id] ?? await readImage(r.id); if (img) zip.file('Fotos/' + r.file, img, { base64: true }); }
        await shareFile(`Steuerbelege_${y}.zip`, await zip.generateAsync({ type: 'blob' }), 'Steuerbelege ' + y);
        hint.textContent = '';
      } catch { hint.textContent = 'Export hat nicht geklappt. Versuch es nochmal.'; }
    });
  };

  $('#set-key').onsubmit = e => {
    e.preventDefault();
    db.settings.apiKey = $('#st-key').value.trim(); db.settings.modelQuick = $('#st-mq').value.trim() || 'claude-haiku-5-5'; db.settings.modelSmart = $('#st-ms').value.trim() || 'claude-sonnet-5-5';
    save(); toast('Gespeichert');
  };
  // Schlüssel aus der Zwischenablage übernehmen, speichern und gleich testen.
  $('#st-paste').onclick = async () => {
    const t = (await paste()).trim();
    const m = t.match(/sk-ant-[A-Za-z0-9_\-]+/);
    if (!m) { $('#st-keyhint').textContent = t ? 'In der Zwischenablage ist kein Schlüssel (er beginnt mit „sk-ant-“). Kopier ihn nochmal.' : 'Die Zwischenablage ist leer. Kopier den Schlüssel zuerst.'; return; }
    $('#st-key').value = m[0]; db.settings.apiKey = m[0]; save();
    $('#st-test').click();
  };
  $('#st-test').onclick = async () => {
    db.settings.apiKey = $('#st-key').value.trim(); save();
    await busy($('#st-test'), $('#st-keyhint'), 'Teste …', async () => {
      try { await ask('Antworte nur mit: ok', { maxTokens: 5 }); await ask('Antworte nur mit: ok', { smart: true, maxTokens: 5 }); $('#st-keyhint').textContent = 'Verbindung klappt, beide Modelle antworten.'; }
      catch (e) { $('#st-keyhint').textContent = aiMsg(e); }
    });
  };
  $('#set-goals').onsubmit = e => { e.preventDefault(); db.settings.kcalGoal = num($('#st-kcal').value); db.settings.proteinGoal = num($('#st-prot').value); save(); toast('Ziele gespeichert'); };
  $('#set-plz').onsubmit = e => { e.preventDefault(); const p = $('#st-plz').value.trim(); if (p && !/^\d{5}$/.test(p)) { toast('Die Postleitzahl hat 5 Ziffern.'); return; } db.settings.plz = p; save(); toast('Gespeichert'); };
  $('#st-war').onchange = () => { db.settings.warrantyRemind = $('#st-war').checked; save(); syncWarranty(); };
  $('#hh-add').onclick = () => { db.settings.household.push({ id: uid(), name: 'Neue Person', kind: 'adult', factor: 1, likes: '', dislikes: '' }); $('#hh-list').innerHTML = ''; save(); };
  $('#st-time').onchange = () => { db.settings.trainTime = $('#st-time').value || '18:00'; save(); reschedule(); };
  $('#st-dur').onchange = () => { db.settings.trainMinutes = num($('#st-dur').value) || 60; save(); };
  $('#st-remind').onchange = () => { db.settings.remind = $('#st-remind').checked; save(); reschedule(); };
  $('#st-cal').onclick = async () => {
    const s = db.settings; const start = nextTrainingStart();
    if (!start) { $('#st-timehint').textContent = 'Wähl zuerst deine Trainingstage.'; return; }
    const by = s.trainDays.map(i => ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][i]).join(',');
    try {
      await addCalendar({ title: 'Training', description: db.plan ? `${db.plan.name}: Plan in Kraftkost` : 'Fitnessstudio', begin: start.getTime(), end: start.getTime() + s.trainMinutes * 60000, rrule: `FREQ=WEEKLY;BYDAY=${by}` });
      $('#st-timehint').textContent = 'Kalender geöffnet. Dort einmal speichern, dann wiederholt sich der Termin jede Woche.';
    } catch (e) { $('#st-timehint').textContent = e.message; }
  };
  $('#st-alarm').onclick = async () => {
    const s = db.settings; const [h, m] = s.trainTime.split(':').map(Number);
    let ah = h, am = m - 60; while (am < 0) { am += 60; ah--; } if (ah < 0) ah += 24;
    try {
      await setAlarm({ hour: ah, minute: am, message: 'Gleich Training', days: s.trainDays.map(i => [2, 3, 4, 5, 6, 7, 1][i]) });
      $('#st-timehint').textContent = `Wecker für ${String(ah).padStart(2, '0')}:${String(am).padStart(2, '0')} an deinen Trainingstagen gestellt.`;
    } catch (e) { $('#st-timehint').textContent = e.message; }
  };
  /* Familie */
  const famHint = $('#fam-hint');
  $('#fam-sql').onclick = async () => { famHint.textContent = (await copy(setupSQL)) ? 'Setup-Skript kopiert. In Supabase unter „SQL Editor“ einfügen und ausführen.' : 'Kopieren ging nicht. Das Skript liegt auch im GitHub-Repo unter supabase/setup.sql.'; };
  $('#fam-create').onclick = () => busy($('#fam-create'), famHint, 'Verbinde …', async () => {
    try { await createHousehold($('#fam-url').value, $('#fam-key').value); famHint.textContent = 'Haushalt angelegt. Jetzt „Einladung teilen“ und an deine Familie schicken.'; }
    catch (e) { famHint.textContent = e.message; }
  });
  $('#fam-paste').onclick = async () => { const t = await paste(); if (t) $('#fam-code').value = t; else famHint.textContent = 'Zwischenablage ist leer. Füg den Code ins Feld ein.'; };
  $('#fam-join').onclick = () => busy($('#fam-join'), famHint, 'Trete bei …', async () => {
    try { await joinHousehold($('#fam-code').value); $('#fam-code').value = ''; famHint.textContent = 'Verbunden. Einkaufsliste und Wochenplan sind jetzt gemeinsam.'; }
    catch (e) { famHint.textContent = e.message; }
  });
  $('#fam-invite').onclick = async () => {
    const code = inviteCode();
    try { await shareText('Kraftkost-Einladung', `Tritt unserer Kraftkost-Einkaufsliste bei: In der App auf das Zahnrad → Einstellungen → „Mit der Familie teilen“ und diesen Code einfügen:\n\n${code}`); }
    catch { famHint.textContent = (await copy(code)) ? 'Code kopiert. Schick ihn per WhatsApp.' : code; }
  };
  $('#fam-sync').onclick = () => busy($('#fam-sync'), null, '', syncNow);
  $('#fam-off').onclick = e => { if (!armed(e.currentTarget)) return; disconnect(); famHint.textContent = 'Getrennt. Deine Einträge bleiben auf diesem Handy.'; };
  onStatus(renderFamily);
  $('#co-add').onclick = () => { db.settings.companies.push({ id: uid(), name: '', email: '' }); $('#co-list').innerHTML = ''; save(); };

  $('#bk-export').onclick = exportBackup;
  $('#bk-import').onclick = importBackup;
  $('#about').textContent = `Kraftkost ${isNative ? 'App' : 'Vorschau im Browser'} · Daten nur auf diesem Gerät · Nährwerte vom Barcode: Open Food Facts (ODbL)`;
  showMore(S.more);
  addRender(() => { renderWeight(); renderReceipts(); renderTax(); renderSettings(); });
  syncWarranty();
}
