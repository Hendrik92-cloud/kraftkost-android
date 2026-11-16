// Fingerabdruck aller Teile, die nur mit einer neuen APK aufs Handy kommen
// (eigener Java-Code, Berechtigungen, Capacitor-Plugins). Ändert er sich, braucht es
// eine Neuinstallation; sonst reicht ein Update des Web-Teils.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

export function nativeHash(root = '.') {
  const h = createHash('sha256');
  for (const f of readdirSync(`${root}/native`).sort()) h.update(f).update(readFileSync(`${root}/native/${f}`));
  h.update(readFileSync(`${root}/scripts/patch-android.sh`));
  h.update(readFileSync(`${root}/capacitor.config.json`));
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  const deps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([n]) => /capacitor|capgo/.test(n)).sort();
  h.update(JSON.stringify(deps));
  return h.digest('hex').slice(0, 12);
}

if (process.argv[1]?.endsWith('native-hash.mjs')) console.log(nativeHash());
