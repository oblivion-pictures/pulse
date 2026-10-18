import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ablehnungMerken,
  mitteilungenBeimStartFragen,
  mitteilungenNachAnlassFragen,
  SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE,
  vorgehenVorDemDialog,
  type Lage
} from '../src/lib/platform/berechtigungRegel.ts';

const lage = (teil: Partial<Lage> = {}): Lage => ({
  art: 'kamera',
  stand: 'offen',
  iosHuelle: true,
  schonAbgelehnt: false,
  sendungen: 0,
  ...teil
});

test('im Browser ohne Blatt weiter — dort ist die Erlaubnis jederzeit umkehrbar', () => {
  assert.equal(vorgehenVorDemDialog(lage({ iosHuelle: false })), 'weiter');
  assert.equal(vorgehenVorDemDialog(lage({ art: 'mitteilungen', iosHuelle: false })), 'weiter');
});

test('erteilt oder verweigert: ohne Blatt weiter, der Dialog erscheint ohnehin nicht mehr', () => {
  assert.equal(vorgehenVorDemDialog(lage({ stand: 'erteilt' })), 'weiter');
  assert.equal(vorgehenVorDemDialog(lage({ stand: 'verweigert' })), 'weiter');
});

test('Kamera: die Handlung erklaert sich selbst, das Blatt kommt sofort', () => {
  assert.equal(vorgehenVorDemDialog(lage({ art: 'kamera', sendungen: 0 })), 'erklaeren');
});

// Die beiden Faelle aus dem Bughunt 2026-10-11 (T6): vorher hiess „keine
// Erklaerung" fuer den Aufrufer „ohne Blatt weiter" — der System-Dialog ging
// auf, obwohl er gar nicht haette erscheinen duerfen. „nicht" ist der einzige
// Ausgang, an dem der Aufrufer KEINEN Dialog stellt.
test('Mitteilungen ohne Anlass: weder Blatt noch System-Dialog', () => {
  assert.equal(vorgehenVorDemDialog(lage({ art: 'mitteilungen', sendungen: 0 })), 'nicht');
  assert.equal(
    vorgehenVorDemDialog(
      lage({ art: 'mitteilungen', sendungen: SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE - 1 })
    ),
    'nicht'
  );
});

test('Mitteilungen nach "spaeter": weder Blatt noch System-Dialog, auch mit Anlass', () => {
  assert.equal(
    vorgehenVorDemDialog(lage({ art: 'mitteilungen', schonAbgelehnt: true, sendungen: 500 })),
    'nicht'
  );
});

test('Mitteilungen mit Anlass: erst das Blatt', () => {
  assert.equal(
    vorgehenVorDemDialog(
      lage({ art: 'mitteilungen', sendungen: SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE })
    ),
    'erklaeren'
  );
  // Die Schwelle sperrt nicht nachtraeglich.
  assert.equal(vorgehenVorDemDialog(lage({ art: 'mitteilungen', sendungen: 500 })), 'erklaeren');
});

test('ein alter "spaeter"-Merker bei Kamera sperrt die Handlung nicht', () => {
  // Fuer Kamera und Mikrofon wird „spaeter" nie gemerkt; steht trotzdem einer
  // da, darf er weder das Blatt ueberspringen noch die Kamera verweigern.
  assert.equal(vorgehenVorDemDialog(lage({ art: 'kamera', schonAbgelehnt: true })), 'erklaeren');
});

test('nur ein anlassloses "spaeter" wird dauerhaft gemerkt', () => {
  // Mitteilungen haben keine ausloesende Handlung: "spaeter" heisst "frag mich
  // nicht wieder".
  assert.equal(ablehnungMerken('mitteilungen'), true);
  // Die Kamera wird von einer Handlung ausgeloest: "spaeter" bricht
  // die Handlung ab und sagt nichts ueber die naechste. Wuerde man es merken,
  // kaeme beim naechsten Oeffnen der System-Dialog OHNE Erklaerung — genau
  // das, was dieser Punkt verhindern soll.
  assert.equal(ablehnungMerken('kamera'), false);
});

test('ein „später" vor der Mitteilungsfrage hält eine Weile, nicht für immer (F3)', async () => {
  // iOS-Bughunt 2, F3: ohne je gefragt zu haben, führt iOS die App nicht
  // unter Einstellungen → Mitteilungen — ein endgültiges „später" sperrte
  // Mitteilungen damit für immer.
  const { spaeterGiltNoch, SPAETER_GILT_MS } = await import(
    '../src/lib/platform/berechtigungRegel.ts'
  );
  const damals = 1_000_000;
  assert.equal(spaeterGiltNoch(damals, damals + 1), true);
  assert.equal(spaeterGiltNoch(damals, damals + SPAETER_GILT_MS - 1), true);
  assert.equal(spaeterGiltNoch(damals, damals + SPAETER_GILT_MS), false);
  // Was ältere Bauten gemerkt haben (`true` ohne Zeitpunkt), gilt als
  // abgelaufen — sonst blieben genau die Getroffenen gesperrt.
  assert.equal(spaeterGiltNoch(true, damals), false);
  assert.equal(spaeterGiltNoch(undefined, damals), false);
});

// Eigentümer-Entscheid 2026-10-16: Android behält den alten Weg.
test('Android-Hülle: kein Blatt, auch nicht vor der Kamera', () => {
  // Die Android-Hülle meldet `iosHuelle: false` — wie im Browser geht es
  // ohne Blatt direkt an den System-Dialog.
  for (const art of ['kamera', 'mitteilungen'] as const) {
    assert.equal(vorgehenVorDemDialog(lage({ art, iosHuelle: false, sendungen: 9 })), 'weiter');
  }
});

test('Mitteilungsfrage: Android beim Start, iOS nach einem Anlass, sonst nirgends', () => {
  assert.equal(mitteilungenBeimStartFragen('android'), true);
  assert.equal(mitteilungenBeimStartFragen('ios'), false);
  assert.equal(mitteilungenBeimStartFragen(null), false);
  assert.equal(mitteilungenNachAnlassFragen('ios'), true);
  assert.equal(mitteilungenNachAnlassFragen('android'), false);
  assert.equal(mitteilungenNachAnlassFragen(null), false);
});

test('die erste eigene Sendung genügt als Anlass', () => {
  assert.equal(SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE, 1);
  assert.equal(vorgehenVorDemDialog(lage({ art: 'mitteilungen', sendungen: 0 })), 'nicht');
  assert.equal(vorgehenVorDemDialog(lage({ art: 'mitteilungen', sendungen: 1 })), 'erklaeren');
});

test('ein anderer Anlass ohne eigene Sendung: das Blatt kommt', () => {
  // Angenommene Freundschaftsanfrage, erste eingehende DM.
  assert.equal(
    vorgehenVorDemDialog(lage({ art: 'mitteilungen', sendungen: 0, anlass: true })),
    'erklaeren'
  );
});

test('ein anderer Anlass hebelt weder "spaeter" noch eine entschiedene Lage aus', () => {
  assert.equal(
    vorgehenVorDemDialog(
      lage({ art: 'mitteilungen', anlass: true, schonAbgelehnt: true })
    ),
    'nicht'
  );
  assert.equal(
    vorgehenVorDemDialog(lage({ art: 'mitteilungen', anlass: true, stand: 'verweigert' })),
    'weiter'
  );
  assert.equal(
    vorgehenVorDemDialog(lage({ art: 'mitteilungen', anlass: true, iosHuelle: false })),
    'weiter'
  );
});

test('der Anlass gilt nur für Mitteilungen', () => {
  // Kamera und Mikrofon haben ihre Handlung; der Merker ändert dort nichts.
  assert.equal(vorgehenVorDemDialog(lage({ art: 'kamera', anlass: true })), 'erklaeren');
});
