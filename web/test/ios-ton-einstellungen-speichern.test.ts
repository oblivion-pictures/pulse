import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUDIO_SECTION } from '../src/lib/settings-registry/sections/audio.ts';

// L1 der Prüfung „Volle Tonqualität" (2026-10-17): die beiden iOS-Schalter
// wurden direkt an `settings.audio` zugewiesen und damit nie gespeichert.
// Gespeichert wird nur über die Setter der Registry (`set`/`patch`).

const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SRC = fileURLToPath(new URL('../src', import.meta.url));

test('der gespeicherte Wert übersteht das Neuladen (parse)', () => {
  const parse = AUDIO_SECTION.parse!;
  const gespeichert = JSON.parse(
    JSON.stringify({ ...AUDIO_SECTION.defaults, iosVolleTonqualitaet: true, bluetoothHq: true })
  );
  const geladen = parse(gespeichert);
  // „Volle Tonqualität" gibt es nicht mehr: der alte Schlüssel wird beim Laden
  // fallengelassen und beim nächsten Speichern nicht mehr geschrieben.
  assert.equal('iosVolleTonqualitaet' in geladen, false);
  assert.equal(geladen.bluetoothHq, true);
  // Bluetooth-HQ im nativen Kanal: Vorgabe an, ein gespeichertes „aus" bleibt.
  assert.equal(parse({}).iosFunkHq, true);
  assert.equal(parse({ iosFunkHq: false }).iosFunkHq, false);
});

test('die Schalter gehen über die Setter der Registry', () => {
  const store = lesen('../src/lib/stores/settings.svelte.ts');
  assert.doesNotMatch(store, /setBluetoothHq/, 'der Web-Schalter ist entfernt (E6)');
  const ui = lesen('../src/lib/components/settings/IosTonEinstellungen.svelte');
  assert.doesNotMatch(ui, /setBluetoothHq|tonHqFunkSetzen/);
  assert.match(store, /setIosFunkHq\(v: boolean\): void \{\s*this\.#audio\.set\('iosFunkHq', v\);/);
  assert.match(ui, /settings\.setIosFunkHq\(v\)/);
});

function dateien(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return dateien(p);
    return /\.(svelte|ts)$/.test(n) ? [p] : [];
  });
}

test('nirgends eine direkte Zuweisung an einen Einstellungs-Bereich', () => {
  const muster =
    /settings\.(audio|voice|appearance|layout|notifications|screenShare|shortcuts|sounds|streamChat)\.[A-Za-z]+\s*(=[^=]|\+=|-=)/;
  const treffer = dateien(SRC).filter((p) => muster.test(readFileSync(p, 'utf8')));
  assert.deepEqual(treffer, [], 'direkte Zuweisung speichert nicht — Setter nehmen');
});

test('W2: der alte Web-Schalter wird einmalig in den einen iOS-Schalter übernommen', async () => {
  const { funkHqAusAltemSchalter } = await import('../src/lib/platform/iosBluetoothHq.ts');
  // Ein ausdrückliches „an" des alten Schalters gewinnt gegen ein „aus" des neuen.
  assert.equal(funkHqAusAltemSchalter(true, false), true);
  // Nichts zu tun: schon an, oder der alte stand nur auf der Vorgabe „aus".
  assert.equal(funkHqAusAltemSchalter(true, true), null);
  assert.equal(funkHqAusAltemSchalter(false, false), null);
  assert.equal(funkHqAusAltemSchalter(false, true), null);
});
