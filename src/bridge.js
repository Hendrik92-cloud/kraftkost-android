/* Weg ohne API-Schlüssel: Anfrage kopieren → in der Claude-App stellen → Antwort zurück einfügen. */
import { Clipboard } from '@capacitor/clipboard';
import { $, esc, toast } from './util.js';
import { isNative } from './native.js';

export async function copy(text) {
  try {
    if (isNative) await Clipboard.write({ string: text });
    else await navigator.clipboard.writeText(text);
    return true;
  } catch { return false; }
}
export async function paste() {
  try {
    if (isNative) return (await Clipboard.read()).value || '';
    return await navigator.clipboard.readText();
  } catch { return ''; }
}
export function extractJSON(t) {
  t = String(t).replace(/```json|```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

/**
 * Zeigt in `box` die drei Schritte. prompt: Text für Claude.
 * onData(json) wird mit der eingefügten Antwort aufgerufen und gibt true zurück, wenn sie passte.
 */
export function showBridge(box, prompt, onData) {
  const full = prompt + '\n\nWichtig: Antworte ausschließlich mit einem JSON-Codeblock, ohne weiteren Text, damit ich ihn in meine App Kraftkost einfügen kann.';
  box.innerHTML = `<div class="card" style="background:var(--bg)">
    <h3>Über die Claude-App, ohne Zusatzkosten</h3>
    <ol class="small" style="margin:0;padding-left:20px;display:grid;gap:4px">
      <li>Anfrage kopieren</li>
      <li>In der Claude-App einen neuen Chat öffnen, einfügen und senden</li>
      <li>Die Antwort kopieren (Kopieren-Symbol am Codeblock) und hier einfügen</li>
    </ol>
    <div class="actions"><button type="button" class="primary" data-b="copy">1. Anfrage kopieren</button></div>
    <details><summary>Anfrage ansehen</summary><textarea readonly rows="6" style="font-size:13px">${esc(full)}</textarea></details>
    <div class="actions"><button type="button" class="primary" data-b="paste">3. Antwort einfügen</button></div>
    <details><summary>Klappt das Einfügen nicht? Hier hinein</summary><textarea rows="4" data-b="area" placeholder="Antwort von Claude"></textarea><button type="button" class="sm" data-b="use">Übernehmen</button></details>
    <p class="hint" data-b="hint"></p></div>`;
  const hint = box.querySelector('[data-b=hint]');
  const take = txt => {
    const j = extractJSON(txt);
    if (!j) { hint.textContent = 'Darin steckt kein gültiger Block. Kopiere die ganze Antwort von Claude noch einmal.'; return; }
    try { if (onData(j)) box.innerHTML = ''; else hint.textContent = 'Die Antwort passt nicht zu dieser Anfrage. Kopiere die richtige Antwort.'; }
    catch { hint.textContent = 'Die Antwort war unvollständig. Bitte Claude, sie vollständig zu wiederholen.'; }
  };
  box.querySelector('[data-b=copy]').onclick = async () => {
    if (await copy(full)) { hint.textContent = 'Kopiert. Jetzt in der Claude-App einfügen.'; toast('Anfrage kopiert'); }
    else { box.querySelector('details').open = true; hint.textContent = 'Kopieren ging nicht automatisch. Markiere den Text oben und kopiere ihn.'; }
  };
  box.querySelector('[data-b=paste]').onclick = async () => {
    const t = await paste();
    if (!t) { box.querySelectorAll('details')[1].open = true; hint.textContent = 'Zwischenablage ist leer oder gesperrt. Füg die Antwort ins Feld unten ein.'; return; }
    take(t);
  };
  box.querySelector('[data-b=use]').onclick = () => take(box.querySelector('[data-b=area]').value);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
