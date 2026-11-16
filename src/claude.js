import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { db, save } from './store.js';

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
  let buf = '', text = '', stop = null, bytes = 0;
  onText?.('', 0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
        else if (ev.type === 'message_delta') stop = ev.delta?.stop_reason || stop;
        if (ev.type === 'error') throw apiError(ev.error?.type === 'overloaded_error' ? 529 : 500, { error: ev.error });
      }
      onText?.(text, bytes);
    }
  } catch (e) {
    if (e instanceof AIError) throw e;
    throw new AIError('network', 'Die Verbindung zu Claude ist abgebrochen. Versuch es nochmal, am besten im WLAN.');
  }
  return { text, stop };
}

/** Normale Anfrage (für die Websuche, die zwischendurch pausieren kann). Mit langer Wartezeit. */
async function callPlain(body, url = URL_, method = 'POST') {
  if (Capacitor.isNativePlatform()) {
    let r;
    try { r = await CapacitorHttp.request({ url, method, headers: headers(), data: body ?? undefined, connectTimeout: 30000, readTimeout: 300000, responseType: 'text' }); }
    catch (e) {
      if (/timeout/i.test(String(e?.message))) throw new AIError('timeout', 'Claude hat zu lange gebraucht. Versuch es nochmal, am besten im WLAN.');
      throw new AIError('network', 'Keine Verbindung zu Claude. Prüf dein Internet.');
    }
    const data = typeof r.data === 'string' ? (() => { try { return JSON.parse(r.data); } catch { return { raw: r.data }; } })() : (r.data || {});
    if (r.status < 200 || r.status >= 300) throw apiError(r.status, data);
    return data;
  }
  let res;
  try { res = await webFetch()(url, { method, headers: headers(), body: body == null ? undefined : JSON.stringify(body) }); }
  catch { throw new AIError('network', 'Keine Verbindung zu Claude. Prüf dein Internet.'); }
  const raw = await res.text(); let data = {}; try { data = JSON.parse(raw); } catch { data = { raw }; }
  if (!res.ok) throw apiError(res.status, data);
  return data;
}

/**
 * Fragt Claude. images: Base64-JPEGs. webSearch: Claude darf im Internet suchen.
 * smart: größeres Modell für Pläne und Fotos. onText: Fortschritt beim Schreiben.
 */
function buildBody(prompt, { smart = false, images = [], maxTokens = 2000, system } = {}) {
  const content = [
    ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
    { type: 'text', text: prompt }
  ];
  const body = { model: smart ? db.settings.modelSmart : db.settings.modelQuick, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  if (system) body.system = system;
  // Die 5.5-Modelle denken sonst erst lange still nach. Das kostet Zeit und Tokens und
  // frisst bei langen Plänen das Antwortlimit auf. Für unsere Aufgaben reicht direktes Schreiben.
  if (/sonnet-5/.test(body.model)) { body.thinking = { type: 'between_tools' }; body.output_config = { effort: 'medium' }; }
  else if (/haiku-5/.test(body.model)) body.thinking = { type: 'disabled' };
  return body;
}

/** Bildschirm wach halten, solange Claude schreibt (wo das Handy es erlaubt). */
async function wake() { try { return await navigator.wakeLock?.request('screen'); } catch { return null; } }

export async function ask(prompt, opts = {}) {
  const { webSearch = false, onText } = opts;
  if (!hasKey()) throw new AIError('no_key', 'Für diese Funktion braucht die App deinen API-Schlüssel. Trag ihn unter Zahnrad → Einstellungen ein.');
  const body = buildBody(prompt, opts);
  const messages = body.messages;

  if (!webSearch) {
    const lock = await wake();
    try {
      try { return await callStream(body, onText); }
      catch (e) {
        // Falls die API die Denk-Einstellung nicht annimmt: einmal ohne versuchen.
        if (e.code === 'api' && /thinking|effort|output_config/i.test(e.message) && (body.thinking || body.output_config)) {
          delete body.thinking; delete body.output_config;
          return await callStream(body, onText);
        }
        throw e;
      }
    } finally { lock?.release?.().catch?.(() => {}); }
  }

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

const JSON_HINT = '\n\nAntworte ausschließlich mit gültigem JSON, ohne Erklärtext und ohne Markdown.';

/**
 * opts.background = { kind, ctx }: Reißt die Verbindung ab (Handy gesperrt, App gewechselt,
 * Funkloch), macht Claude die Antwort auf dem Server fertig. Die App holt sie später ab
 * und übergibt sie dem mit registerJob angemeldeten Empfänger.
 */
export async function askJSON(prompt, opts = {}) {
  let res;
  try { res = await ask(prompt + JSON_HINT, opts); }
  catch (e) {
    if (opts.background && e.code === 'network') {
      await submitJob(opts.background, buildBody(prompt + JSON_HINT, opts));
      throw new AIError('background', 'Die Verbindung ist abgerissen. Claude macht den Plan jetzt im Hintergrund fertig. Du kannst das Handy weglegen: Sobald er da ist, übernimmt die App ihn beim nächsten Öffnen von selbst (meist nach wenigen Minuten).');
    }
    throw e;
  }
  if (opts.background && db.aiJobs?.[opts.background.kind]) { delete db.aiJobs[opts.background.kind]; save(); }
  const { text, stop } = res;
  const j = extractJSON(text);
  if (j == null) {
    if (stop === 'max_tokens') throw new AIError('too_long', 'Die Antwort war zu lang und wurde abgeschnitten. Versuch es nochmal.');
    throw new AIError('invalid_json', 'Die Antwort war unvollständig. Versuch es nochmal.');
  }
  return j;
}

/* ---------- Aufträge im Hintergrund (Batch-API, halber Preis, läuft ohne offene Verbindung) ---------- */
const BATCH = 'https://api.anthropic.com/v1/messages/batches';
const handlers = {};
let pollT = null, polling = false;

async function submitJob({ kind, ctx }, body) {
  let r;
  try { r = await callPlain({ requests: [{ custom_id: kind, params: body }] }, BATCH); }
  catch (e) { if (e.code === 'network' || e.code === 'timeout') throw new AIError('network', 'Die Verbindung zu Claude ist abgebrochen. Versuch es nochmal, am besten im WLAN.'); throw e; }
  db.aiJobs = db.aiJobs || {};
  db.aiJobs[kind] = { batch: r.id, ctx, at: Date.now() };
  save(); schedulePoll(20000);
}

/** Empfänger für fertige Hintergrund-Aufträge. fn(json, ctx) gibt true zurück, wenn übernommen. */
export function registerJob(kind, fn) { handlers[kind] = fn; }
export const pendingJob = kind => db.aiJobs?.[kind] || null;

function schedulePoll(ms) {
  clearTimeout(pollT);
  if (Object.keys(db.aiJobs || {}).length) pollT = setTimeout(pollJobs, ms);
}

export async function pollJobs() {
  if (polling || !hasKey()) return;
  const jobs = Object.entries(db.aiJobs || {});
  if (!jobs.length) return;
  polling = true;
  try {
    for (const [kind, job] of jobs) {
      if (Date.now() - job.at > 30 * 3600 * 1000) { delete db.aiJobs[kind]; continue; }
      const st = await callPlain(null, `${BATCH}/${job.batch}`, 'GET');
      if (st.processing_status !== 'ended') continue;
      delete db.aiJobs[kind];
      const out = await callPlain(null, st.results_url || `${BATCH}/${job.batch}/results`, 'GET');
      const line = String(out.raw ?? JSON.stringify(out)).split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).find(x => x?.custom_id === kind);
      const msg = line?.result?.type === 'succeeded' ? line.result.message : null;
      const j = msg ? extractJSON((msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('')) : null;
      const ok = j && handlers[kind] ? handlers[kind](j, job.ctx) : false;
      window.dispatchEvent(new CustomEvent('kk-job', { detail: { kind, ok } }));
    }
  } catch { /* nächstes Mal wieder */ }
  finally { polling = false; save(); schedulePoll(30000); }
}

function extractJSON(t) {
  t = String(t).replace(/```json|```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

export const aiMsg = e => (e instanceof AIError ? e.message : 'Das hat nicht geklappt. Versuch es nochmal.');
