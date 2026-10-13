/**
 * App-Download-Quellen (`web/src/lib/downloads/appDownloads.ts`).
 *
 * Seit dem Umzug auf GitHub Releases (Schritt 2, 2026-10-13) liegen Windows,
 * macOS, Android und die Server-App unter `releases/latest/download/<Name>`;
 * NUR das Flatpak bleibt auf dem eigenen Server. Dieselben Adressen stehen an
 * drei weiteren Stellen, die keinen Import teilen — `landing.js`, die
 * Plattform-Kacheln in `landing.html` und die nginx-Weiterleitungen der alten
 * Bequem-Adressen. Ein Wert, der an einer Stelle abweicht, fällt sonst
 * niemandem auf: ein Download-Knopf, der ins Leere läuft, ist kein Fehler, den
 * ein Build meldet. `landing.js` prüft `landing.test.ts`, der Rest steht hier.
 *
 * `appDownloads.ts` ist importfrei, deshalb direkt erreichbar (die zwei Fallen
 * stehen in CLAUDE.md unter „pnpm test:unit"). Der Rest wird als Text gelesen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as q from '../src/lib/downloads/appDownloads.ts';

function lese(rel: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), 'utf8');
}

const GITHUB = 'https://github.com/oblivion-pictures/pulse/releases/latest/download';

/** Ein Export nach Namen — das Modul ist für einen Namen aus einer Liste zu eng getypt. */
function wert(modul: object, name: string): unknown {
  return (modul as Record<string, unknown>)[name];
}

/** Konstante -> (fester Dateiname im Release, alte Bequem-Adresse auf dem eigenen Server). */
const APPS = {
  WINDOWS_INSTALLER_URL: ['Pulse-Setup-Windows.exe', '/updates/win/Pulse-Setup-latest.exe'],
  MAC_DMG_URL: ['Pulse-macOS.dmg', '/downloads/Pulse-latest.dmg'],
  ANDROID_APK_URL: ['Pulse-Android.apk', '/downloads/pulse-latest.apk'],
  WINDOWS_SERVER_INSTALLER_URL: [
    'Pulse-Server-Setup-Windows.exe',
    '/updates/win-server/Pulse-Server-Setup-latest.exe'
  ],
  MAC_SERVER_DMG_URL: ['Pulse-Server-macOS.dmg', '/downloads/Pulse-Server-latest.dmg']
} as const;

test('Windows, macOS, Android und die Server-App kommen aus dem GitHub-Release', () => {
  for (const [konstante, [name]] of Object.entries(APPS)) {
    assert.equal(wert(q, konstante), `${GITHUB}/${name}`, konstante);
  }
});

test('das Flatpak bleibt auf dem eigenen Server — Client und Server-App', () => {
  assert.equal(
    q.LINUX_FLATPAKREF_URL,
    'https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref'
  );
  assert.equal(
    q.LINUX_SERVER_FLATPAKREF_URL,
    'https://howispulse.com/flatpak/com.howispulse.PulseServer.flatpakref'
  );
  assert.equal(
    q.LINUX_INSTALL_COMMAND,
    'flatpak install --from https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref'
  );
  assert.equal(
    q.LINUX_SERVER_INSTALL_COMMAND,
    'flatpak install --from https://howispulse.com/flatpak/com.howispulse.PulseServer.flatpakref'
  );
});

test('keine App-Adresse zeigt mehr auf die alten Pfade des eigenen Servers', () => {
  // Gegenprobe zur Umleitung: wer die Konstante auf die Bequem-Adresse
  // zurückstellt, hängt den Download wieder an die Auto-Update-Ordner.
  for (const [konstante, adresse] of Object.entries(q)) {
    if (typeof adresse !== 'string' || !adresse.startsWith('https://')) continue;
    assert.ok(
      !/howispulse\.com\/(updates|downloads)\//.test(adresse),
      `${konstante}: ${adresse}`
    );
  }
});

test('die Plattform-Kacheln in landing.html tragen dieselben Adressen', () => {
  const html = lese('../static/landing.html');
  const kacheln = [
    ...html.matchAll(/<a\s+class="lp-plattform"\s+href="(https:\/\/[^"]+)"/g)
  ].map((t) => t[1]);
  assert.deepEqual(
    kacheln.sort(),
    [q.WINDOWS_INSTALLER_URL, q.MAC_DMG_URL, q.LINUX_FLATPAKREF_URL, q.ANDROID_APK_URL].sort()
  );
});

test('die Dateinamen sind genau die, die das Release-Skript als vollständig verlangt', () => {
  // `github-release.sh` macht ein Release erst zu „Latest", wenn alle Namen aus
  // VOLLSTAENDIG da sind. Heißt ein Link anders, führt er ins Leere, obwohl
  // jedes Release vollständig ist.
  const skript = lese('../../infra/release/github-release.sh');
  const zeile = skript.match(/^VOLLSTAENDIG=\(([^)]*)\)/ms);
  assert.ok(zeile, 'VOLLSTAENDIG=(…) nicht gefunden');
  const namen = zeile[1].split(/\s+/).filter(Boolean).sort();
  assert.deepEqual(namen, Object.values(APPS).map(([name]) => name).sort());
});

test('nginx leitet GENAU die fünf alten Bequem-Adressen nach GitHub um', () => {
  const nginx = lese('../../infra/prod/web-nginx.conf');
  const gefunden = [
    ...nginx.matchAll(/location = (\/(?:updates|downloads)\/\S+) \{\s*return (\d+) (\S+);\s*\}/g)
  ].map((t) => ({ pfad: t[1], code: t[2], ziel: t[3] }));

  const erwartet = Object.entries(APPS).map(([konstante, [, alt]]) => ({
    pfad: alt,
    code: '302',
    ziel: wert(q, konstante)
  }));
  const nachPfad = (a: { pfad: string }, b: { pfad: string }) => a.pfad.localeCompare(b.pfad);
  assert.deepEqual(gefunden.sort(nachPfad), erwartet.sort(nachPfad));
});

test('die Auto-Update-Feeds und der Rest von /downloads/ bleiben unberührt', () => {
  // Die Feed-Dateien (latest.yml …) liegen weiter hier; nur ihre Adressen zeigen
  // auf GitHub (Schritt 3, `infra/release/feed-auf-github.sh`). Eine Umleitung
  // auf Präfix-Ebene risse die Feeds und den Rückfall daneben mit.
  const nginx = lese('../../infra/prod/web-nginx.conf');
  const bloecke: Array<[string, string]> = [
    ['/updates/win/', '/srv/updates-win/'],
    ['/updates/win-server/', '/srv/updates-win-server/'],
    ['/updates/mac/', '/srv/updates-mac/'],
    ['/updates/mac-server/', '/srv/updates-mac-server/'],
    ['/downloads/', '/srv/downloads/'],
    ['/flatpak/', '/srv/flatpak-repo/']
  ];
  for (const [pfad, ordner] of bloecke) {
    const treffer = nginx.match(
      new RegExp(`location \\^~ ${pfad.replace(/\//g, '\\/')} \\{([^}]*)\\}`)
    );
    assert.ok(treffer, `Block ${pfad} fehlt`);
    assert.match(treffer[1], new RegExp(`alias ${ordner.replace(/\//g, '\\/')};`), pfad);
    assert.ok(!/\breturn\b|\brewrite\b/.test(treffer[1]), `${pfad} leitet um`);
  }
});
