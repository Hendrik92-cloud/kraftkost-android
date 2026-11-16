/* Mengen aus dem Wochenplan zusammenrechnen und lesbar ausschreiben. */

const MASS = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000], liter: ['ml', 1000] };
const COUNT = { dose: 'Dose', dosen: 'Dose', scheibe: 'Scheibe', scheiben: 'Scheibe', rolle: 'Rolle', rollen: 'Rolle', pack: 'Pack', packs: 'Pack', packung: 'Pack', packungen: 'Pack', becher: 'Becher', el: 'EL', tl: 'TL', stück: 'Stück', stk: 'Stück', glas: 'Glas', gläser: 'Glas', laib: 'Laib', bund: 'Bund', kopf: 'Kopf', knolle: 'Knolle', beutel: 'Beutel' };
const PLURAL = { Dose: 'Dosen', Scheibe: 'Scheiben', Rolle: 'Rollen', Packung: 'Packungen', Glas: 'Gläser', Knolle: 'Knollen', Beutel: 'Beutel' };

/** "200 g" → {n:200,u:'g'}; "2 × 125 g" → {n:250,u:'g'}; "½" → {n:.5,u:'Stück'}; sonst null. */
export function parseAmount(s) {
  const t = String(s || '').trim().toLowerCase().replace(/½/g, '0.5').replace(/¼/g, '0.25').replace(/(\d),(\d)/g, '$1.$2');
  if (!t) return null;
  let m = t.match(/^(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|liter|l)\b/);
  if (m) { const [u, f] = MASS[m[3]]; return { n: +m[1] * +m[2] * f, u }; }
  m = t.match(/^(\d+(?:\.\d+)?)\s*(kg|g|ml|liter|l)\b/);
  if (m) { const [u, f] = MASS[m[2]]; return { n: +m[1] * f, u }; }
  m = t.match(/^(\d+(?:\.\d+)?)\s*([a-zäöüß]+)?/);
  if (m) {
    const w = m[2] || '';
    if (!w) return { n: +m[1], u: 'Stück' };
    if (COUNT[w]) return { n: +m[1], u: COUNT[w] };
  }
  return null;
}

const ceilTo = (n, step) => Math.ceil(n / step - 1e-9) * step;
const deNum = n => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });

/** Summiert Mengenangaben; gleiche Einheiten werden addiert, Unlesbares bleibt als Text. */
export function sumAmounts(list) {
  const by = new Map(); const texts = new Set();
  for (const a of list) {
    if (!a) continue;
    const p = parseAmount(a);
    if (p) by.set(p.u, (by.get(p.u) || 0) + p.n); else texts.add(String(a).trim());
  }
  const out = [];
  for (const [u, n] of by) {
    if (u === 'g') out.push(n >= 1000 ? `${deNum(ceilTo(n / 1000, 0.1))} kg` : `${ceilTo(n, n > 100 ? 50 : 10)} g`);
    else if (u === 'ml') out.push(n >= 1000 ? `${deNum(ceilTo(n / 1000, 0.5))} Liter` : `${ceilTo(n, 50)} ml`);
    else { const c = Math.ceil(n - 1e-9); out.push(`${c} ${c > 1 ? (PLURAL[u] || u) : u}`); }
  }
  return [...out, ...texts].join(' + ');
}

/** Liest alte Angaben wie „4 l“ eindeutig: „4 Liter“, „15 Stück“. */
export function prettyAmount(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (/^\d+(?:[.,]\d+)?$/.test(t)) return t + (t === '1' ? ' Stück' : ' Stück');
  return t.replace(/(\d)\s*l\b/g, '$1 Liter');
}

const SYN = { ei: 'eier', apfel: 'äpfel', banane: 'bananen', tomate: 'tomaten', zwiebel: 'zwiebeln', gurke: 'gurken', möhre: 'möhren', karotte: 'möhren', kartoffel: 'kartoffeln', paprikaschote: 'paprika', zitrone: 'zitronen' };
/** Schlüssel zum Zusammenfassen gleicher Zutaten. */
export function nameKey(n) {
  const k = String(n || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  return SYN[k] || k;
}
