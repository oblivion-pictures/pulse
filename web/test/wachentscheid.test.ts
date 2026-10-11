import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WS_WACH_FRIST_MS } from '../src/lib/api/constants.ts';
import {
  GESCHLOSSEN,
  MINDESTABSTAND_MS,
  OFFEN,
  SCHLIESST,
  VERBINDET,
  wachEntscheid,
  type Wachlage
} from '../src/lib/ws/wachentscheid.ts';

const lage = (teil: Partial<Wachlage> = {}): Wachlage => ({
  gewuenscht: true,
  bereit: GESCHLOSSEN,
  pruefungLaeuft: false,
  seitLetzterPruefungMs: 60_000,
  ...teil
});

test('abgemeldet: nichts tun, egal wie der Socket steht', () => {
  assert.equal(wachEntscheid(lage({ gewuenscht: false, bereit: OFFEN })), 'nichts');
  assert.equal(wachEntscheid(lage({ gewuenscht: false, bereit: null })), 'nichts');
});

test('kein Socket oder geschlossen: sofort verbinden', () => {
  assert.equal(wachEntscheid(lage({ bereit: null })), 'sofort-verbinden');
  assert.equal(wachEntscheid(lage({ bereit: GESCHLOSSEN })), 'sofort-verbinden');
});

test('im Abbau zaehlt wie geschlossen — der close-Pfad wartet sonst auf den Backoff', () => {
  assert.equal(wachEntscheid(lage({ bereit: SCHLIESST })), 'sofort-verbinden');
});

test('Aufbau laeuft schon: kein zweiter daneben', () => {
  assert.equal(wachEntscheid(lage({ bereit: VERBINDET })), 'nichts');
});

test('offener Socket beweist nichts: Ping mit kurzer Frist', () => {
  assert.equal(wachEntscheid(lage({ bereit: OFFEN })), 'ping-pruefen');
});

test('laufende Pruefung wird nicht verdoppelt', () => {
  assert.equal(wachEntscheid(lage({ bereit: OFFEN, pruefungLaeuft: true })), 'nichts');
});

test('die drei Ausloeser beim Entsperren feuern gemeinsam — nur der erste zaehlt', () => {
  assert.equal(wachEntscheid(lage({ seitLetzterPruefungMs: 0 })), 'nichts');
  assert.equal(
    wachEntscheid(lage({ seitLetzterPruefungMs: MINDESTABSTAND_MS - 1 })),
    'nichts'
  );
  assert.equal(
    wachEntscheid(lage({ seitLetzterPruefungMs: MINDESTABSTAND_MS })),
    'sofort-verbinden'
  );
});

test('nach dem Schliessen eines toten Sockets wählt die Weckprüfung sofort neu (F6)', () => {
  // iOS-Bughunt 2, F6: die Prüfung schloss den toten Socket und wartete auf
  // dessen `close` — das auf totem Netz ungemessen lange ausbleibt. Sie ruft
  // sich danach selbst noch einmal; dieser zweite Ruf muss am Socket im Abbau
  // neu verbinden, und die Frist muss über dem Mindestabstand liegen, sonst
  // schluckte der zweite Ruf sich selbst.
  assert.ok(WS_WACH_FRIST_MS > MINDESTABSTAND_MS);
  assert.equal(
    wachEntscheid(lage({ bereit: SCHLIESST, seitLetzterPruefungMs: WS_WACH_FRIST_MS })),
    'sofort-verbinden'
  );
  const quelle = readFileSync(
    new URL('../src/lib/ws/gateway-connection.ts', import.meta.url),
    'utf8'
  );
  assert.match(quelle, /ws\.close\(\);[\s\S]*?\}\s*\/\/[\s\S]*?this\.wachPruefen\(\);\s*\}, WS_WACH_FRIST_MS\);/);
});
