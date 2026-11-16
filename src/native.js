import { Capacitor, registerPlugin } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { BarcodeScanner, BarcodeFormat } from '@capacitor-mlkit/barcode-scanning';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { resizeBase64 } from './util.js';

export const isNative = Capacitor.isNativePlatform();
const Kraft = registerPlugin('Kraft');

export class NativeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const needApp = () => { if (!isNative) throw new NativeError('web', 'Das geht nur in der installierten App.'); };

/* ---------- Foto ---------- */
function pickFileWeb() {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return res(null);
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.readAsDataURL(f);
    };
    inp.click();
  });
}
/** Foto aufnehmen oder aus der Galerie wählen. Gibt verkleinertes Base64-JPEG zurück oder null. */
export async function takePhoto() {
  let b64 = null;
  if (isNative) {
    try {
      const p = await Camera.getPhoto({
        quality: 75, width: 1600, correctOrientation: true,
        resultType: CameraResultType.Base64, source: CameraSource.Prompt,
        promptLabelHeader: 'Foto', promptLabelPhoto: 'Aus der Galerie', promptLabelPicture: 'Kamera', promptLabelCancel: 'Abbrechen'
      });
      b64 = p.base64String;
    } catch (e) {
      if (/cancel/i.test(String(e?.message))) return null;
      throw new NativeError('camera', 'Die Kamera ließ sich nicht öffnen. Erlaube den Zugriff in den Android-Einstellungen.');
    }
  } else b64 = await pickFileWeb();
  return b64 ? resizeBase64(b64, 1600, 0.72) : null;
}

/* ---------- Spracheingabe ---------- */
export async function listen(prompt = 'Sprich jetzt') {
  if (isNative) {
    const { available } = await SpeechRecognition.available();
    if (!available) throw new NativeError('speech', 'Spracherkennung ist auf diesem Handy nicht verfügbar.');
    const perm = await SpeechRecognition.requestPermissions();
    if (perm.speechRecognition !== 'granted') throw new NativeError('perm', 'Ohne Mikrofon-Erlaubnis geht das nicht. Erlaube es in den Android-Einstellungen.');
    const r = await SpeechRecognition.start({ language: 'de-DE', maxResults: 1, prompt, partialResults: false, popup: true });
    return (r.matches && r.matches[0]) || '';
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new NativeError('web', 'Spracheingabe geht nur in der installierten App.');
  return new Promise((res, rej) => {
    const r = new SR(); r.lang = 'de-DE'; r.maxAlternatives = 1;
    r.onresult = e => res(e.results[0][0].transcript);
    r.onerror = () => rej(new NativeError('speech', 'Nichts verstanden. Versuch es nochmal.'));
    r.start();
  });
}

/* ---------- Barcode + Open Food Facts ---------- */
export async function scanBarcode() {
  needApp();
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (!available) {
    await BarcodeScanner.installGoogleBarcodeScannerModule();
    throw new NativeError('installing', 'Der Scanner wird einmalig installiert. Versuch es in einer Minute nochmal.');
  }
  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.Ean13, BarcodeFormat.Ean8, BarcodeFormat.UpcA, BarcodeFormat.UpcE] });
    return barcodes?.[0]?.rawValue || null;
  } catch (e) {
    if (/cancel/i.test(String(e?.message))) return null;
    throw new NativeError('scan', 'Scannen hat nicht geklappt. Versuch es nochmal.');
  }
}

export async function lookupFood(code) {
  let res;
  try {
    res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_de,brands,nutriments,serving_size,serving_quantity`, {
      headers: { 'User-Agent': 'Kraftkost/1.0 (private Android-App)' }
    });
  } catch { throw new NativeError('network', 'Keine Verbindung zur Lebensmittel-Datenbank.'); }
  const d = await res.json().catch(() => ({}));
  const p = d.product;
  if (!p) return null;
  const n = p.nutriments || {};
  const kcal = n['energy-kcal_100g'] ?? (n['energy_100g'] ? n['energy_100g'] / 4.184 : null);
  return {
    name: [p.product_name_de || p.product_name, p.brands?.split(',')[0]].filter(Boolean).join(' · ') || 'Unbekanntes Produkt',
    kcal: kcal ?? 0, protein: n.proteins_100g ?? 0, carbs: n.carbohydrates_100g ?? 0, fat: n.fat_100g ?? 0,
    serving: Number(p.serving_quantity) || null, servingLabel: p.serving_size || ''
  };
}

/* ---------- Erinnerungen ---------- */
async function notifPerm() {
  if (!isNative) return false;
  const p = await LocalNotifications.requestPermissions();
  return p.display === 'granted';
}
const TRAIN_IDS = [101, 102, 103, 104, 105, 106, 107];

/** days: 0=Mo … 6=So, time "HH:MM". Erinnerung 60 Minuten vorher. */
export async function scheduleTraining(days, time, on) {
  if (!isNative) return false;
  await LocalNotifications.cancel({ notifications: TRAIN_IDS.map(id => ({ id })) }).catch(() => {});
  if (!on || !days.length) return true;
  if (!(await notifPerm())) throw new NativeError('perm', 'Benachrichtigungen sind blockiert. Erlaube sie in den Android-Einstellungen.');
  const [h, m] = time.split(':').map(Number);
  let rh = h - 1; let rd = 0;
  if (rh < 0) { rh = 23; rd = -1; }
  await LocalNotifications.schedule({
    notifications: days.map(d => {
      const day = (d + rd + 7) % 7;
      return {
        id: TRAIN_IDS[d], title: 'Heute ist Trainingstag',
        body: `Um ${time} geht's ins Studio. Dein Plan liegt in Kraftkost bereit.`,
        schedule: { on: { weekday: ((day + 1) % 7) + 1, hour: rh, minute: m }, allowWhileIdle: true }
      };
    })
  });
  return true;
}

/** Tägliche Erinnerung an Nahrungsergänzung, morgens und abends. names: Liste je Tageszeit. */
const SUPP_IDS = { morgens: 201, abends: 202 };
export async function scheduleSupps({ morgens, abends, times, on }) {
  if (!isNative) return false;
  await LocalNotifications.cancel({ notifications: Object.values(SUPP_IDS).map(id => ({ id })) }).catch(() => {});
  const list = [['morgens', morgens], ['abends', abends]].filter(([, n]) => n.length);
  if (!on || !list.length) return true;
  if (!(await notifPerm())) throw new NativeError('perm', 'Benachrichtigungen sind blockiert. Erlaube sie in den Android-Einstellungen.');
  await LocalNotifications.schedule({
    notifications: list.map(([k, names]) => {
      const [h, m] = (times[k] || (k === 'morgens' ? '07:00' : '21:00')).split(':').map(Number);
      return { id: SUPP_IDS[k], title: k === 'morgens' ? 'Morgens einnehmen' : 'Abends einnehmen', body: names.join(', '), schedule: { on: { hour: h, minute: m }, allowWhileIdle: true } };
    })
  });
  return true;
}

/** items: [{id, title, body, at: Date}] — ersetzt alle Garantie-Erinnerungen. */
export async function scheduleWarranty(items) {
  if (!isNative) return;
  const pending = await LocalNotifications.getPending().catch(() => ({ notifications: [] }));
  const old = pending.notifications.filter(n => n.id >= 1000).map(n => ({ id: n.id }));
  if (old.length) await LocalNotifications.cancel({ notifications: old }).catch(() => {});
  const fut = items.filter(i => i.at > new Date());
  if (!fut.length || !(await notifPerm())) return;
  await LocalNotifications.schedule({ notifications: fut.map(i => ({ id: i.id, title: i.title, body: i.body, schedule: { at: i.at, allowWhileIdle: true } })) });
}

/* ---------- Kalender, Wecker, Timer ---------- */
export async function addCalendar(opts) { needApp(); return Kraft.addCalendarEvent(opts); }
export async function setAlarm(opts) { needApp(); return Kraft.setAlarm(opts); }
export async function setTimer(seconds, message) { needApp(); return Kraft.setTimer({ seconds, message }); }
export async function sendMail(to, subject, body) {
  if (isNative) return Kraft.sendMail({ to, subject, body });
  location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/* ---------- Teilen / Export ---------- */
/** data: Text oder Blob. */
export async function shareFile(filename, data, title) {
  if (!isNative) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    return;
  }
  let written;
  if (data instanceof Blob) {
    const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(data); });
    written = await Filesystem.writeFile({ path: filename, data: b64, directory: Directory.Cache });
  } else {
    written = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache, encoding: Encoding.UTF8 });
  }
  await Share.share({ title, files: [written.uri] });
}

export async function shareText(title, text) {
  if (isNative) return Share.share({ title, text, dialogTitle: title });
  if (navigator.share) return navigator.share({ title, text });
  await navigator.clipboard.writeText(text);
}

export const tap = () => { if (isNative) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); };
export const buzz = () => { if (isNative) Haptics.vibrate({ duration: 600 }).catch(() => {}); else navigator.vibrate?.(600); };
