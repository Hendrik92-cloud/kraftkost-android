import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { db } from './store.js';

export class AIError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const hasKey = () => !!db.settings.apiKey;

const URL_ = 'https://api.anthropic.com/v1/messages';
const headers = () => ({
  'content-type': 'application/json',
  'x-api-key': db.settings.apiKey.trim(),
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true'
});
/** Das ungepatchte fetch der WebView: kann Antworten Stück für Stück lesen. */
const webFetch = () => (window.CapacitorWebFetch || window.fetch).bind(window);

function apiError(status, data) {
  const m = data?.error?.message || '';
  if (status === 401) return new AIError('auth', 'Der API-Schlüssel stimmt nicht. Prüf ihn unter Zahnrad → Einstellungen.');
  if (status === 429) return new AIError('rate', 'Zu viele Anfragen. Versuch es in einer Minute nochmal.');
  if (/credit|balance|billing/i.test(m)) return new AIError('credit', 'Dein API-Guthaben ist aufgebraucht. Lade es in der Anthropic Console auf.');
  if (status === 404 || /model/i.test(m)) return new AIError('model', 'Das eingestellte Modell gibt es nicht. Prüf den Modellnamen in den Einstellungen.');
  if (status >= 500 || data?.error?.type === 'overloaded_error') return new AIError('overloaded', 'Claude ist gerade überlastet. Versuch es gleich nochmal.');
  return new AIError('api', 'Claude hat die Anfrage abgelehnt: ' + m);
}

/**
 * Antwort als Strom: Claude schickt laufend Text, dadurch bleibt die Verbindung auch bei
 * Antworten von ein, zwei Minuten offen. onText bekommt den bisherigen Text (für Fortschritt).
 */
async function callStream(body, onText) {
  let res;
  try { res = await webFetch()(URL_, { method: 'POST', headers: headers(), body: JSON.stringify({ ...body, stream: true }) }); }
  catch { throw new AIError('network', 'Keine Verbindung zu Claude. Prüf dein Internet.'); }
  if (!res.ok) { let data = {}; try { data = await res.json(); } catch { /* leer */ } throw apiError(res.status, data); }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = '', stop = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { text += ev.delta.text; onText?.(text); }
        else if (ev.type === 'message_delta') stop = ev.delta?.stop_reason || stop;
        else if (ev.type === 'error') throw apiError(ev.error?.type === 'overloaded_error' ? 529 : 500, { error: ev.error });
      }
    }
  } catch (e) {
    if (e instanceof AIError) throw e;
    throw new AIError('network', 'Die Verbindung zu Claude ist abgebrochen. Versuch es nochmal, am besten im WLAN.');
  }
  return { text, stop };
}

/** Normale Anfrage (für die Websuche, die zwischendurch pausieren kann). Mit langer Wartezeit. */
async function callPlain(body) {
  if (Capacitor.isNativePlatform()) {
    let r;
    try { r = await CapacitorHttp.request({ url: URL_, method: 'POST', headers: headers(), data: body, connectTimeout: 30000, readTimeout: 300000 }); }
    catch (e) {
      if (/timeout/i.test(String(e?.message))) throw new AIError('timeout', 'Claude hat zu lange gebraucht. Versuch es nochmal, am besten im WLAN.');
      throw new AIError('network', 'Keine Verbindung zu Claude. Prüf dein Internet.');
    }
    const data = typeof r.data === 'string' ? (() => { try { return JSON.parse(r.data); } catch { return {}; } })() : (r.data || {});
    if (r.status < 200 || r.status >= 300) throw apiError(r.status, data);
    return data;
  }
  let res;
  try { res = await webFetch()(URL_, { method: 'POST', headers: headers(), body: JSON.stringify(body) }); }
  catch { throw new AIError('network', 'Keine Verbindung zu Claude. Prüf dein Internet.'); }
  let data = {}; try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) throw apiError(res.status, data);
  return data;
}

/**
 * Fragt Claude. images: Base64-JPEGs. webSearch: Claude darf im Internet suchen.
 * smart: größeres Modell für Pläne und Fotos. onText: Fortschritt beim Schreiben.
 */
export async function ask(prompt, { smart = false, images = [], maxTokens = 2000, webSearch = false, system, onText } = {}) {
  if (!hasKey()) throw new AIError('no_key', 'Für diese Funktion braucht die App deinen API-Schlüssel. Trag ihn unter Zahnrad → Einstellungen ein.');
  const content = [
    ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
    { type: 'text', text: prompt }
  ];
  const messages = [{ role: 'user', content }];
  const body = { model: smart ? db.settings.modelSmart : db.settings.modelQuick, max_tokens: maxTokens, messages };
  if (system) body.system = system;

  if (!webSearch) return callStream(body, onText);

  body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
  let data = await callPlain(body);
  // Lange Websuchen kann die API unterbrechen: dann einfach fortsetzen lassen.
  for (let i = 0; i < 3 && data.stop_reason === 'pause_turn'; i++) {
    messages.push({ role: 'assistant', content: data.content });
    data = await callPlain({ ...body, messages });
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
