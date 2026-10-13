/**
 * Jeder generic-Update-Feed der Apps verlangt EINZELNE Bereichsanfragen
 * (`useMultipleRangeRequest: false`).
 *
 * Warum: die Update-Dateien liegen künftig in GitHub-Releases, und deren
 * Asset-Server beantwortet eine Anfrage mit mehreren Bereichen mit 501
 * (gemessen 2026-10-13). electron-updater versucht das Delta dann mit genau
 * so einer Anfrage, scheitert und lädt die ganze Datei. Die Einstellung liest
 * er aus der eingebauten `app-update.yml` — die electron-builder aus dem
 * `publish:`-Block dieser Dateien schreibt (app-builder-lib,
 * `getAppUpdatePublishConfiguration`: `{...publishConfigs[0]}`). Fehlt die
 * Zeile in EINEM Block, fällt nur eine Plattform still auf den vollen Download
 * zurück; nichts schlägt fehl, jedes Update wird bloß so groß wie die ganze
 * Datei statt nur der geänderten Blöcke.
 *
 * Die yml-Dateien werden zeilenweise gelesen: `desktop` hat keine YAML-
 * Abhängigkeit, und eine neue wäre für diese zwei Dateien zu viel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DESKTOP = join(import.meta.dirname, '..');
const FELD = 'useMultipleRangeRequest';

interface Befund {
  /** Anzahl der gefundenen `provider: generic`-Blöcke. */
  generic: number;
  /** Beschreibung jedes Blocks, dem die Einstellung fehlt. */
  fehlend: string[];
}

/** Zeile ohne Kommentar (`# …` ab einem Leerzeichen) und ohne Rand. */
function ohneKommentar(zeile: string): string {
  return zeile.replace(/(^|\s)#.*$/, '').trimEnd();
}

function einzug(zeile: string): number {
  return zeile.length - zeile.trimStart().length;
}

/** Sammelt die Zeilen unter `zeilen[von]` (dem `publish:`-Kopf): alles, was tiefer
 *  eingerückt ist; Leer- und Kommentarzeilen laufen mit, egal wie eingerückt. */
function blockUnter(zeilen: string[], von: number): string[] {
  const kopfEinzug = einzug(zeilen[von]);
  const block: string[] = [];
  for (let i = von + 1; i < zeilen.length; i++) {
    const roh = zeilen[i];
    if (ohneKommentar(roh).trim() === '') continue;
    if (einzug(roh) <= kopfEinzug) break;
    block.push(ohneKommentar(roh));
  }
  return block;
}

/** Prüft jeden `publish:`-Block (und, mit `wurzel`, die Wurzel selbst, wie in
 *  `dev-app-update.yml`, wo der Feed ohne `publish:` steht). */
function pruefe(text: string, opts: { wurzel?: boolean } = {}): Befund {
  const zeilen = text.split(/\r?\n/);
  const bloecke: { name: string; zeilen: string[] }[] = [];

  zeilen.forEach((zeile, i) => {
    const kopf = ohneKommentar(zeile);
    if (!/^\s*publish:/.test(kopf)) return;
    assert.match(kopf, /^\s*publish:\s*$/, `Zeile ${i + 1}: \`publish:\` mit Inline-Wert — Test kennt nur die Blockform`);
    bloecke.push({ name: `publish: in Zeile ${i + 1}`, zeilen: blockUnter(zeilen, i) });
  });
  if (opts.wurzel) {
    bloecke.push({ name: 'Wurzel der Datei', zeilen: zeilen.map(ohneKommentar).filter((z) => z.trim() !== '' && einzug(z) === 0) });
  }

  const befund: Befund = { generic: 0, fehlend: [] };
  for (const { name, zeilen: inhalt } of bloecke) {
    const provider = inhalt.filter((z) => /^\s*(-\s+)?provider:/.test(z));
    assert.ok(provider.length <= 1, `${name}: mehrere \`provider:\` in einem Block — der Test kann die Zuordnung nicht entscheiden`);
    if (!provider[0] || !/provider:\s*generic\s*$/.test(provider[0])) continue;
    befund.generic++;
    if (!inhalt.some((z) => new RegExp(`^\\s*${FELD}:\\s*false\\s*$`).test(z))) befund.fehlend.push(name);
  }
  return befund;
}

function lies(datei: string): string {
  return readFileSync(join(DESKTOP, datei), 'utf8');
}

for (const datei of ['electron-builder.yml', 'electron-builder-server.yml']) {
  test(`${datei}: jeder generic-Feed verlangt Einzelbereiche`, () => {
    const befund = pruefe(lies(datei));
    // Windows und macOS. Fände der Leser nichts, bestünde der Test leer.
    assert.ok(befund.generic >= 2, `${datei}: nur ${befund.generic} generic-publish-Block(e) gefunden, erwartet mindestens 2 (win + mac)`);
    assert.deepEqual(befund.fehlend, [], `${datei}: \`${FELD}: false\` fehlt in: ${befund.fehlend.join(', ')}`);
  });
}

test('dev-app-update.yml: der lokale Test läuft wie die ausgelieferte App', () => {
  const befund = pruefe(lies('dev-app-update.yml'), { wurzel: true });
  assert.equal(befund.generic, 1, 'dev-app-update.yml: generic-Feed an der Wurzel nicht gefunden');
  assert.deepEqual(befund.fehlend, [], `dev-app-update.yml: \`${FELD}: false\` fehlt`);
});

// ── Gegenproben: der Leser selbst ───────────────────────────────────────────
// Ein Prüfer, der nie rot wird, ist keiner. Diese Fälle halten ihn scharf.

const GUT = `
publish:
  provider: generic
  url: https://example.invalid/win/
  ${FELD}: false
mac:
  publish:
    provider: generic
    url: https://example.invalid/mac/
    ${FELD}: false
`;

test('Leser: beide Blöcke vollständig → grün', () => {
  assert.deepEqual(pruefe(GUT), { generic: 2, fehlend: [] });
});

test('Leser: fehlende Zeile im mac-Block wird gefunden, auch wenn Windows sie hat', () => {
  const kaputt = GUT.replace(`    ${FELD}: false\n`, '');
  const befund = pruefe(kaputt);
  assert.equal(befund.generic, 2);
  assert.equal(befund.fehlend.length, 1);
  assert.match(befund.fehlend[0], /Zeile 7/);
});

test('Leser: true, auskommentiert oder an fremdem Ort zählt nicht', () => {
  assert.equal(pruefe(GUT.replaceAll(`${FELD}: false`, `${FELD}: true`)).fehlend.length, 2);
  assert.equal(pruefe(GUT.replaceAll(`  ${FELD}: false`, `  # ${FELD}: false`)).fehlend.length, 2);
  // Feld liegt NACH dem Block auf Wurzelebene: gehört nicht zu publish.
  const draussen = `publish:\n  provider: generic\n  url: https://example.invalid/\n${FELD}: false\n`;
  assert.deepEqual(pruefe(draussen), { generic: 1, fehlend: ['publish: in Zeile 1'] });
});

test('Leser: ein Block mit anderem Provider wird ignoriert', () => {
  const s3 = `publish:\n  provider: s3\n  bucket: x\n`;
  assert.deepEqual(pruefe(s3), { generic: 0, fehlend: [] });
});

test('Leser: Inline-Schreibweise und Listenform werden laut abgelehnt, nicht still übergangen', () => {
  assert.throws(() => pruefe(`publish: { provider: generic, url: x }\n`), /Inline-Wert/);
  const liste = `publish:\n  - provider: generic\n    url: a\n  - provider: generic\n    url: b\n`;
  assert.throws(() => pruefe(liste), /mehrere `provider:`/);
});
