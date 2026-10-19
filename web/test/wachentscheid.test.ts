import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WS_WACH_FRIST_MS } from '../src/lib/api/constants.ts';
import {
  ABWEISENDE_ZUSTAENDE,
  GESCHLOSSEN,
  MINDESTABSTAND_MS,
  OFFEN,
  SCHLIESST,
  VERBINDET,
  hintergrundTrennung,
  wachEntscheid,
  zustandImHintergrund,
  type Wachlage
} from '../src/lib/ws/wachentscheid.ts';

const lage = (teil: Partial<Wachlage> = {}): Wachlage => ({
  gewuenscht: true,
  zustand: 'closed',
  bereit: GESCHLOSSEN,
  pruefungLaeuft: false,
  seitLetzterPruefungMs: 60_000,
  imHintergrund: false,
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

// Fixliste 16 (2026-10-16): eine aktive Abweisung behält ihre Staffel.
test('zu alt, im Update, gesperrt: kein Sofortversuch, die Staffel gilt', () => {
  for (const zustand of ['incompatible', 'updating', 'suspended']) {
    assert.ok(ABWEISENDE_ZUSTAENDE.includes(zustand), zustand);
    assert.equal(wachEntscheid(lage({ zustand, bereit: null })), 'nichts', zustand);
    assert.equal(wachEntscheid(lage({ zustand, bereit: GESCHLOSSEN })), 'nichts', zustand);
  }
  // Ein gewöhnlicher Abriss bekommt ihn weiter.
  assert.equal(wachEntscheid(lage({ zustand: 'closed', bereit: null })), 'sofort-verbinden');
});

// Hintergrund-Trennung (2026-10-19): Android-Hülle löst die Verbindungen im
// Hintergrund, damit der Server auf FCM-Push umstellt — außer im Sprachkanal
// oder Anruf, deren Signalisierung an derselben Leitung hängt.
test('hintergrundTrennung: nur Android-Hülle, und nicht mit Sperre', () => {
  // Browser/Tab: nie — der Desktop will im Hintergrund-Tab live bleiben.
  assert.equal(hintergrundTrennung(false, []), false);
  // Android-Hülle ohne Sperre: trennen, damit FCM zustellen darf.
  assert.equal(hintergrundTrennung(true, []), true);
  // Laufender Sprachkanal oder Anruf: Verbindung halten.
  assert.equal(hintergrundTrennung(true, [() => true]), false);
  assert.equal(hintergrundTrennung(true, [() => false, () => true]), false);
  // Eine Sperre, die nur meldet, dass sie nicht greift, steht nicht im Weg.
  assert.equal(hintergrundTrennung(true, [() => false]), true);
});

// Nachbesserung PR #627: Die Trennung muss halten. Vorher verband ein
// `online` im Hintergrund sofort neu (Zustand 'closed', kein Socket ⇒
// 'sofort-verbinden'), und der Server stellte wieder keinen Push zu.
test('im Hintergrund gelöst: kein Weckanlass verbindet, egal wie der Socket steht', () => {
  for (const bereit of [null, GESCHLOSSEN, SCHLIESST, OFFEN, VERBINDET]) {
    assert.equal(wachEntscheid(lage({ imHintergrund: true, bereit })), 'nichts');
  }
  // Wieder vorn: derselbe Zustand verbindet sofort.
  assert.equal(wachEntscheid(lage({ imHintergrund: false, bereit: null })), 'sofort-verbinden');
});

test('Hintergrund-Zustand: nur ein laufender/stehender Socket wird zu closed', () => {
  assert.equal(zustandImHintergrund('open'), 'closed');
  assert.equal(zustandImHintergrund('connecting'), 'closed');
  // Absichtlich getrennt (Self-Host) bleibt getrennt.
  assert.equal(zustandImHintergrund('idle'), 'idle');
  assert.equal(zustandImHintergrund('closed'), 'closed');
  // Server-Abweisungen behalten Zustand und damit ihre Anzeige.
  for (const z of ABWEISENDE_ZUSTAENDE) assert.equal(zustandImHintergrund(z), z);
});

test('nach dem Fortsetzen respektiert der Weckpfad die Staffel einer Abweisung', () => {
  // Abgewiesen, in den Hintergrund, zurück: der Zustand ist erhalten, also
  // kein Sofortversuch — die Leiter läuft weiter (Bughunt 43).
  for (const z of ABWEISENDE_ZUSTAENDE) {
    const zustand = zustandImHintergrund(z);
    assert.equal(wachEntscheid(lage({ zustand, bereit: null, imHintergrund: false })), 'nichts');
  }
  // Ein gewöhnlich offener Socket dagegen wird nach dem Fortsetzen sofort
  // neu verbunden.
  const zustand = zustandImHintergrund('open');
  assert.equal(wachEntscheid(lage({ zustand, bereit: null })), 'sofort-verbinden');
});
