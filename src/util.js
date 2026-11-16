export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const iso = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
export const today = () => iso(new Date());
export const addDays = (s, n) => { const d = new Date(s + 'T12:00'); d.setDate(d.getDate() + n); return iso(d); };
export const addYears = (s, n) => { const d = new Date(s + 'T12:00'); d.setFullYear(d.getFullYear() + n); return iso(d); };
export const daysUntil = s => Math.round((new Date(s + 'T12:00') - new Date(today() + 'T12:00')) / 864e5);
export const fmtDay = s => new Date(s + 'T12:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDate = s => new Date(s + 'T12:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
export const fmtShort = s => new Date(s + 'T12:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
export const eur = n => (Number(n) || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
export const de = (n, d = 0) => (Number(n) || 0).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const num = v => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const wdOf = dt => (new Date(dt + 'T12:00').getDay() + 6) % 7;
export const words = s => String(s).toLowerCase().split(/[^a-zäöüß0-9]+/).filter(w => w.length >= 4);

let toastT;
export function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800);
}

/** Bild verkleinern und als JPEG-Base64 (ohne data:-Präfix) zurückgeben. */
export function resizeBase64(b64, max = 1600, q = 0.75) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', q).split(',')[1]);
    };
    img.onerror = () => rej(new Error('Bild konnte nicht gelesen werden'));
    img.src = 'data:image/jpeg;base64,' + b64;
  });
}

/** Zweistufiges Löschen: erster Tipp scharf schalten, zweiter löscht. */
export function armed(btn) {
  if (btn.classList.contains('armed')) return true;
  const old = btn.textContent;
  btn.classList.add('armed'); btn.textContent = 'Löschen?';
  setTimeout(() => { btn.classList.remove('armed'); btn.textContent = old; }, 3000);
  return false;
}
