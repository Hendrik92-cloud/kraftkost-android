import { db } from './store.js';

export class AIError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const hasKey = () => !!db.settings.apiKey;

async function call(body) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': db.settings.apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw new AIError('network', 'Keine Verbindung zu Claude. Prüf dein Internet.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    const m = data?.error?.message || '';
    if (res.status === 401) throw new AIError('auth', 'Der API-Schlüssel stimmt nicht. Prüf ihn unter Zahnrad → Einstellungen.');
    if (res.status === 429) throw new AIError('rate', 'Zu viele Anfragen. Versuch es in einer Minute nochmal.');
    if (/credit|balance|billing/i.test(m)) throw new AIError('credit', 'Dein API-Guthaben ist aufgebraucht. Lade es in der Anthropic Console auf.');
    if (res.status === 404 || /model/i.test(m)) throw new AIError('model', 'Das eingestellte Modell gibt es nicht. Prüf den Modellnamen in den Einstellungen.');
    if (res.status >= 500) throw new AIError('overloaded', 'Claude ist gerade überlastet. Versuch es gleich nochmal.');
    throw new AIError('api', 'Claude hat die Anfrage abgelehnt: ' + m);
  }
  return data;
}

/**
 * Fragt Claude. images: Base64-JPEGs. webSearch: Claude darf im Internet suchen.
 * smart: größeres Modell für Pläne und Fotos.
 */
export async function ask(prompt, { smart = false, images = [], maxTokens = 2000, webSearch = false, system } = {}) {
  if (!hasKey()) throw new AIError('no_key', 'Für diese Funktion braucht die App deinen API-Schlüssel. Trag ihn unter Zahnrad → Einstellungen ein.');
  const content = [
    ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
    { type: 'text', text: prompt }
  ];
  const messages = [{ role: 'user', content }];
  const body = { model: smart ? db.settings.modelSmart : db.settings.modelQuick, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];

  let data = await call(body);
  // Lange Websuchen kann die API unterbrechen: dann einfach fortsetzen lassen.
  for (let i = 0; i < 3 && data.stop_reason === 'pause_turn'; i++) {
    messages.push({ role: 'assistant', content: data.content });
    data = await call({ ...body, messages });
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, stop: data.stop_reason };
}

export async function askJSON(prompt, opts) {
  const { text, stop } = await ask(prompt + '\n\nAntworte ausschließlich mit gültigem JSON, ohne Erklärtext und ohne Markdown.', opts);
  const j = extractJSON(text);
  if (j == null) {
    if (stop === 'max_tokens') throw new AIError('too_long', 'Die Antwort war zu lang und wurde abgeschnitten. Versuch es nochmal.');
    throw new AIError('invalid_json', 'Die Antwort war unvollständig. Versuch es nochmal.');
  }
  return j;
}

function extractJSON(t) {
  t = String(t).replace(/```json|```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

export const aiMsg = e => (e instanceof AIError ? e.message : 'Das hat nicht geklappt. Versuch es nochmal.');
