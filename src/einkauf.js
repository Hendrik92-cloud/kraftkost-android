import { db, save } from './store.js';
import { addRender, busy } from './app.js';
import { $, $$, esc, eur, uid, today, fmtDay, toast, words, de, daysUntil } from './util.js';
import { askJSON, aiMsg, hasKey } from './claude.js';
import { showBridge } from './bridge.js';
import { listen } from './native.js';

export const CATS = ['Obst & Gemüse', 'Fleisch & Fisch', 'Kühlregal', 'Brot & Trockenware', 'Konserven & Vorrat', 'Tiefkühl', 'Getränke', 'Drogerie & Haushalt', 'Sonstiges'];
const STORES = ['Aldi', 'Lidl', 'Penny', 'Netto'];
let storeFilter = 'Alle';

/** Fügt Artikel hinzu, ohne Doppelte. Gibt die Anzahl neuer Einträge zurück. */
export function addShopItems(items) {
  let n = 0;
  items.forEach(it => {
    const name = String(it.name || '').trim(); if (!name) return;
    const ex = live().find(x => !x.done && x.name.toLowerCase() === name.toLowerCase());
    if (ex) { if (it.amount && !ex.amount) { ex.amount = it.amount; touch(ex); } return; }
    db.shop.push(touch({ id: uid(), name, amount: it.amount || '', cat: it.cat || guessCat(name), done: false }));
    n++;
  });
  if (n) save();
  return n;
}
/** Änderung für den Familien-Abgleich vormerken. */
const touch = x => { x.updated = Date.now(); x.dirty = true; return x; };
/** Einträge ohne die zum Löschen vorgemerkten. */
const live = () => db.shop.filter(x => !x.deleted);
const removeItem = x => { if (db.settings.sync) { x.deleted = true; touch(x); } else db.shop = db.shop.filter(s => s !== x); };
const CAT_HINTS = [
  ['Obst & Gemüse', /apfel|banane|beere|tomate|gurke|paprika|salat|zwiebel|knoblauch|kartoffel|möhre|karotte|brokkoli|zucchini|champignon|pilz|obst|gemüse|zitrone|spinat|kohl|lauch|avocado|birne|traube/i],
  ['Fleisch & Fisch', /hähnchen|huhn|pute|rind|schwein|hack|fleisch|lachs|thunfisch|fisch|wurst|schinken|filet/i],
  ['Kühlregal', /milch|joghurt|quark|käse|butter|sahne|ei(er)?\b|eier|skyr|frischkäse|mozzarella|feta|tofu/i],
  ['Brot & Trockenware', /brot|brötchen|toast|nudel|pasta|reis|hafer|müsli|mehl|linsen|couscous|bulgur|wrap/i],
  ['Tiefkühl', /tiefkühl|tk[- ]|gefror/i],
  ['Getränke', /wasser|saft|kaffee|tee|cola|bier|getränk/i],
  ['Drogerie & Haushalt', /papier|spül|seife|zahn|shampoo|müll|tücher|waschmittel/i]
];
const guessCat = n => (CAT_HINTS.find(([, re]) => re.test(n)) || ['Sonstiges'])[0];

function matches(name) {
  const o = db.offers?.items || []; const ws = words(name); if (!ws.length) return [];
  return o.filter(x => { const n = String(x.name).toLowerCase(); return ws.some(w => n.includes(w)); }).sort((a, b) => a.price - b.price).slice(0, 3);
}

function renderShop() {
  const it = live();
  const box = $('#s-list');
  if (!it.length) { box.innerHTML = '<div class="empty">Die Liste ist leer. Sprich oder tipp oben etwas ein, oder lass sie aus dem Wochenplan erstellen.</div>'; }
  else {
    const open = it.filter(x => !x.done), done = it.filter(x => x.done);
    const groups = CATS.map(c => [c, open.filter(x => (x.cat || 'Sonstiges') === c)]).filter(([, xs]) => xs.length);
    if (done.length) groups.push(['Erledigt', done]);
    box.innerHTML = '<div class="list">' + groups.map(([c, xs]) => `<div class="group-h"><span>${esc(c)}</span><span>${xs.length}</span></div>` + xs.map(x => {
      const m = x.done ? [] : matches(x.name);
      return `<div class="item ${x.done ? 'done' : ''}"><input type="checkbox" class="chk" id="s-${x.id}" data-chk="${x.id}" ${x.done ? 'checked' : ''}>
        <label for="s-${x.id}" class="main" style="display:block;text-transform:none;letter-spacing:0;font-size:inherit;color:inherit;font-weight:inherit">
          <div class="t">${esc(x.name)}${x.amount ? ` <span class="s">${esc(x.amount)}</span>` : ''}</div>
          ${m.length ? `<div class="chips">${m.map(o => `<span class="chip">${esc(o.store)} ${eur(o.price)}</span>`).join('')}</div>` : ''}
        </label><button type="button" class="del" data-srm="${x.id}" aria-label="Von der Liste nehmen">×</button></div>`;
    }).join('')).join('') + '</div>';
    box.querySelectorAll('[data-chk]').forEach(c => c.onchange = () => { const x = db.shop.find(s => s.id === c.dataset.chk); if (x) { x.done = c.checked; touch(x); save(); } });
    box.querySelectorAll('[data-srm]').forEach(b => b.onclick = () => { const x = db.shop.find(s => s.id === b.dataset.srm); if (x) { removeItem(x); save(); } });
  }
  $('#s-clear').hidden = !it.some(x => x.done);
  renderHead(it); renderCompare(); renderOffers();
}

/** Übersicht oben: was noch fehlt und wo es am günstigsten ist. */
function renderHead(it) {
  const open = it.filter(x => !x.done), done = it.length - open.length;
  const inOffer = open.filter(x => matches(x.name).length).length;
  const cats = [...new Set(open.map(x => x.cat || 'Sonstiges'))].length;
  $('#s-head').innerHTML = `<h3>Einkaufsliste</h3>
    <div class="bignum"><b>${open.length}</b><span>${open.length === 1 ? 'Sache fehlt' : 'Sachen fehlen'}${cats > 1 ? ` · ${cats} Bereiche im Laden` : ''}</span></div>
    ${it.length ? `<div class="progress"><div class="bar"><div class="fill" style="width:${it.length ? done / it.length * 100 : 0}%"></div></div><span>${done} von ${it.length} im Wagen</span></div>` : ''}
    <div class="chips">${inOffer ? `<span class="chip">${inOffer} im Angebot</span>` : ''}${db.settings.sync ? '<span class="chip t">mit der Familie geteilt</span>' : ''}${db.mealplan?.shopping?.length ? '<span class="chip mute">aus dem Wochenplan</span>' : ''}</div>`;
}

function renderCompare() {
  const box = $('#s-compare'); const open = live().filter(x => !x.done); const O = db.offers?.items || [];
  if (!O.length || !open.length) { box.hidden = true; return; }
  const rows = STORES.map(st => {
    let n = 0, save_ = 0;
    open.forEach(x => {
      const ws = words(x.name); if (!ws.length) return;
      const o = O.filter(o => o.store.startsWith(st) && ws.some(w => String(o.name).toLowerCase().includes(w))).sort((a, b) => a.price - b.price)[0];
      if (o) { n++; if (o.oldPrice > o.price) save_ += o.oldPrice - o.price; }
    });
    return { st, n, save: save_ };
  }).filter(r => r.n).sort((a, b) => b.n - a.n || b.save - a.save);
  box.hidden = false;
  box.innerHTML = '<h3>Wo lohnt sich der Einkauf?</h3>' + (rows.length
    ? `<div class="list">${rows.map((r, i) => `<div class="item"><div class="main"><div class="t">${r.st}${i === 0 ? ' <span class="chip t">am meisten im Angebot</span>' : ''}</div><div class="s">${r.n} von ${open.length} Sachen im Angebot${r.save > 0 ? ` · spart ca. ${eur(r.save)}` : ''}</div></div></div>`).join('')}</div>`
    : '<p class="small muted">Für deine aktuelle Liste ist diese Woche nichts im Angebot.</p>');
}

function renderOffers() {
  const O = db.offers;
  $('#o-filter').innerHTML = ['Alle', ...STORES].map(s => `<button type="button" data-of="${s}" aria-pressed="${storeFilter === s}">${s}</button>`).join('');
  $$('[data-of]').forEach(b => b.onclick = () => { storeFilter = b.dataset.of; renderOffers(); });
  const list = $('#o-list');
  if (!O || !(O.items || []).length) {
    $('#o-meta').textContent = db.settings.plz ? `Für PLZ ${db.settings.plz}.` : 'Trag unter Zahnrad → Einstellungen deine Postleitzahl ein, die Angebote sind regional.';
    list.innerHTML = '<div class="empty">Noch keine Angebote. „Angebote suchen“ lässt Claude die aktuellen Prospekte von Aldi, Lidl, Penny und Netto im Internet durchsuchen, passend zu deiner Liste.</div>';
    return;
  }
  const age = daysUntil(O.updatedAt) * -1;
  $('#o-meta').textContent = `Gesucht ${age === 0 ? 'heute' : fmtDay(O.updatedAt)}${O.plz ? ' für PLZ ' + O.plz : ''}${O.note ? ' · ' + O.note : ''}. Ohne Gewähr, im Laden kann es abweichen.${age >= 7 ? ' Die Angebote sind über eine Woche alt.' : ''}`;
  const xs = O.items.filter(o => storeFilter === 'Alle' || o.store.startsWith(storeFilter));
  list.innerHTML = xs.length ? '<div class="list">' + xs.map((o, i) => `<div class="item"><div class="main"><div class="tag">${esc(o.store)}</div><div class="t">${esc(o.name)}</div><div class="s">${[o.unit, o.valid].filter(Boolean).map(esc).join(' · ')}</div></div><span class="num">${o.oldPrice ? `<span class="old">${eur(o.oldPrice)}</span>` : ''}${eur(o.price)}</span><button type="button" class="ghost sm" data-addo="${i}" aria-label="Auf die Liste">+</button></div>`).join('') + '</div>'
    : '<div class="empty">Für diesen Laden ist gerade nichts eingetragen.</div>';
  list.querySelectorAll('[data-addo]').forEach(b => b.onclick = () => { const o = xs[+b.dataset.addo]; toast(addShopItems([{ name: o.name }]) ? 'Auf die Liste gesetzt' : 'Steht schon auf der Liste'); });
}

async function searchOffers() {
  const plz = db.settings.plz;
  if (!plz) { toast('Trag zuerst deine Postleitzahl unter Zahnrad → Einstellungen ein.'); return; }
  const wanted = [...new Set(live().filter(x => !x.done).map(x => x.name).concat((db.mealplan?.days || []).flatMap(d => d.meals.flatMap(m => m.ingredients.map(z => z.name)))))].slice(0, 40);
  const prompt = `Suche im Internet die aktuell gültigen Lebensmittel-Angebote dieser Woche (heute ist ${fmtDay(today())} ${today().slice(0, 4)}) bei Aldi, Lidl, Penny und Netto Marken-Discount für die Postleitzahl ${plz}. Kläre, ob dort Aldi Nord oder Aldi Süd zuständig ist.
${wanted.length ? 'Achte besonders auf diese Produkte von der Einkaufsliste und aus dem Essensplan: ' + wanted.join(', ') + '.' : ''}
Außerdem gesunde Grundnahrungsmittel: Fleisch, Fisch, Milchprodukte, Quark, Eier, Obst, Gemüse, Haferflocken, Reis, Nudeln, Hülsenfrüchte. Keine Non-Food-Artikel, keine Süßigkeiten, kein Alkohol.
Nimm nur Angebote auf, die du in einer Quelle für diese Woche gefunden hast, und erfinde keine Preise. Höchstens 15 pro Laden.
Form: {"art":"angebote","angebote":[{"laden":"Lidl","name":"Hähnchenbrustfilet","einheit":"1 kg","preis":6.99,"normalpreis":9.99,"gueltig":"Mo 16.11. – Sa 21.11."}],"hinweis":"kurz, z. B. Aldi Nord, Woche 47"}`;
  const apply = r => {
    const items = (r.angebote || []).map(o => ({
      store: String(o.laden || '').replace(/marken-?discount/i, '').trim() || 'Unbekannt', name: String(o.name || ''), unit: String(o.einheit || ''),
      price: Number(String(o.preis).replace(',', '.')) || 0, oldPrice: Number(String(o.normalpreis).replace(',', '.')) || null, valid: String(o.gueltig || '')
    })).filter(o => o.name && o.price > 0);
    if (!items.length) return false;
    db.offers = { items, note: String(r.hinweis || ''), plz, updatedAt: today() };
    save(); toast(`${items.length} Angebote übernommen`);
    return true;
  };
  if (!hasKey()) { showBridge($('#o-bridge'), prompt, apply); return; }
  const btn = $('#o-search');
  await busy(btn, null, '', async () => {
    btn.textContent = 'Suche läuft …';
    $('#o-meta').textContent = 'Claude durchsucht die aktuellen Prospekte. Das dauert ein bis zwei Minuten …';
    try { if (!apply(await askJSON(prompt, { webSearch: true, maxTokens: 8000 }))) $('#o-meta').textContent = 'Keine Angebote gefunden. Versuch es später nochmal.'; }
    catch (e) { $('#o-meta').textContent = aiMsg(e); }
    finally { btn.textContent = 'Angebote suchen'; }
  });
}

function splitSpoken(t) {
  return t.split(/,|\bund\b|\bsowie\b/i).map(s => s.trim()).filter(Boolean).map(s => s.charAt(0).toUpperCase() + s.slice(1));
}

export function initEinkauf() {
  $('#sform').onsubmit = e => {
    e.preventDefault();
    const v = $('#s-name').value.trim(); if (!v) return;
    const n = addShopItems(v.split(',').map(s => ({ name: s.trim() })));
    $('#s-name').value = ''; toast(n ? 'Auf die Liste gesetzt' : 'Steht schon auf der Liste');
  };
  $('#s-mic').onclick = async () => {
    try {
      const t = await listen('Zum Beispiel: Milch, Eier und Bananen'); if (!t) return;
      const n = addShopItems(splitSpoken(t).map(name => ({ name })));
      toast(n ? `${n} ${n === 1 ? "Sache" : "Sachen"} auf die Liste gesetzt` : 'Steht schon alles drauf');
    } catch (e) { toast(e.message); }
  };
  $('#s-clear').onclick = () => { live().filter(x => x.done).forEach(removeItem); save(); };
  $('#o-search').onclick = searchOffers;
  addRender(renderShop);
}
