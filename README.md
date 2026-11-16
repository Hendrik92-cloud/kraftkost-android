# Kraftkost für Android

Private Fitness- und Ernährungs-App: Studio-Trainingsplan mit Steigerung, Familien-Wochenplan, Essen mit Sprache, Foto und Barcode, Belege für Steuer und Garantie, Einkaufsliste mit Angeboten.

## Installieren

1. Auf dem Handy unter **Releases** die neueste `Kraftkost.apk` herunterladen.
2. Öffnen und „Installation aus dieser Quelle erlauben“ bestätigen.
3. In der App unter **Mehr → Einstellungen** den Claude-API-Schlüssel eintragen (console.anthropic.com).

Jeder Push auf `main` baut automatisch eine neue APK (GitHub Actions). Updates lassen sich einfach drüberinstallieren, die Daten bleiben erhalten.

## Entwickeln

```bash
npm install
npm run dev        # Vorschau im Browser
npm run build      # Web-Teil bauen
```

Das Android-Projekt wird beim Build erzeugt (`npx cap add android` + `scripts/patch-android.sh`), eigener nativer Code liegt in `native/`.

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/training.js` | Trainingsplan, Steigerung, Satzpause, Spracheingabe |
| `src/essen.js` | Tagesprotokoll, Schätzen, Teller-Foto, Barcode (Open Food Facts) |
| `src/plan.js` | Familien-Wochenplan: tauschen, bearbeiten, fixieren, Einkaufsliste |
| `src/einkauf.js` | Einkaufsliste, Angebotssuche per Claude-Websuche, Ladenvergleich |
| `src/mehr.js` | Gewicht, Belege, Steuer-Export, Einstellungen, Backup |
| `src/native.js` | Kamera, Mikrofon, Barcode, Erinnerungen, Kalender, Wecker |
| `native/KraftPlugin.java` | Kalender-Termin, Wecker, Timer über Android-Intents |

`signing/debug.keystore` sorgt dafür, dass jede APK gleich signiert ist und sich über die alte installieren lässt. Das Repo deshalb privat lassen.
