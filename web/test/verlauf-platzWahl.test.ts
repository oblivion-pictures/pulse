import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ausweichFassung, platzWaehlen } from '../src/lib/verlauf/platzWahl.ts';
import { sortierSchluessel, zuSatz } from '../src/lib/verlauf/satz.ts';

// Gegenprüfung 2026-10-12, Fund 3: eine Archiv-Zeile liegt lokal unter ihrer
// eigenen ID `i`, und die wählt der Einliefernde frei. Bob belegte mit
// `{i: K_alice, a: Bob}` den Schlüssel von Alices Nachricht, und ihre echte
// Zeile wie ihr Satz aus der eigenen Sicherung fielen weg. Den Ablauf gegen
// die echte Datenbank prüft `tests/e2e/verlauf-register.spec.ts`.

const KANAL = '700';
const ALICE = '200';
const BOB = '300';
const K = '1760000000000123456';
const R_ALICE = '5000000000000000001';
const R_BOB = '5000000000000000002';

function satz(felder: Record<string, unknown>) {
  const s = zuSatz(
    KANAL,
    { content: 'hallo', created_at: '2026-10-12T00:00:00Z', verschluesselt: true, ...felder },
    'konto'
  );
  assert.ok(s);
  return s;
}

/** Eine Archiv-Zeile: lokale ID und Kennung `i`, dazu die Zeilen-ID. */
const zeile = (autor: string, i: string, r: string) =>
  satz({ id: i, author_id: autor, krypto_id: i, archiv_zeile: r });

test('zuSatz führt die Zeilen-ID einer Archiv-Zeile mit, sonst nicht', () => {
  assert.equal(zeile(ALICE, K, R_ALICE).archivZeile, R_ALICE);
  assert.equal(satz({ id: K, author_id: ALICE }).archivZeile, undefined);
  assert.equal(satz({ id: K, author_id: ALICE, archiv_zeile: 'x' }).archivZeile, undefined);
});

test('ausweichFassung: lokale ID = Zeilen-ID, die Kennung bleibt `i`, die Identität dieselbe', () => {
  const aus = ausweichFassung(zeile(ALICE, K, R_ALICE));
  assert.ok(aus);
  assert.equal(aus.nachrichtId, R_ALICE);
  assert.equal(aus.schluessel, sortierSchluessel(KANAL, R_ALICE));
  assert.equal(aus.kryptoId, K);
  assert.equal(aus.autorId, ALICE);
  // Kein Ausweichplatz für einen Satz, der nicht aus dem Archiv kommt oder
  // schon dort steht.
  assert.equal(ausweichFassung(satz({ id: K, author_id: ALICE })), null);
  assert.equal(ausweichFassung(aus), null);
});

test('frei oder derselbe Autor: schreiben bzw. ergänzen wie bisher', () => {
  const alice = zeile(ALICE, K, R_ALICE);
  assert.deepEqual(platzWaehlen(undefined, alice, 'archiv'), { art: 'schreiben', satz: alice });
  // Derselbe Satz noch einmal: nichts zu tun.
  assert.deepEqual(platzWaehlen(alice, alice, 'archiv'), { art: 'nichts' });
});

test('Fund 3: Bobs Zeile belegt Alices Schlüssel — Alices Zeile weicht aus, statt wegzufallen', () => {
  const bob = zeile(BOB, K, R_BOB);
  assert.deepEqual(platzWaehlen(bob, zeile(ALICE, K, R_ALICE), 'archiv'), { art: 'ausweichen' });
});

test('Fund 3: Alices eigene Sicherung verdrängt Bobs Archiv-Satz, der weicht dann aus', () => {
  const bob = zeile(BOB, K, R_BOB);
  const ausSicherung = satz({ id: K, author_id: ALICE, content: 'echt' });
  const wahl = platzWaehlen(bob, ausSicherung, 'sicherung');
  assert.deepEqual(wahl, { art: 'verdraengen', satz: ausSicherung, verdraengt: bob });
  assert.equal(ausweichFassung(bob)?.nachrichtId, R_BOB);
});

test('Fund 3: auf ihrem Ausweichplatz verdrängt eine Zeile einen Satz, der dort nur über `i` sitzt', () => {
  // Bob kennt Alices Zeilen-ID (er liest das Archiv mit) und belegt den
  // Ausweichplatz vorab mit einer Zeile `{i: R_alice}`.
  const bobVorab = zeile(BOB, R_ALICE, R_BOB);
  const aliceAusweich = ausweichFassung(zeile(ALICE, K, R_ALICE));
  assert.ok(aliceAusweich);
  assert.deepEqual(platzWaehlen(bobVorab, aliceAusweich, 'archiv'), {
    art: 'verdraengen',
    satz: aliceAusweich,
    verdraengt: bobVorab
  });
});

test('was nicht aus dem Archiv kommt, verdrängt das Archiv nie', () => {
  // Ein eigener Satz unter K (Bob hat K als seine Zeilen-ID gewählt): Bobs
  // Ausweich-Fassung findet ihn vor und bleibt draußen.
  const eigener = satz({ id: K, author_id: ALICE });
  const bobAusweich = ausweichFassung(zeile(BOB, '1760000000000999999', K));
  assert.ok(bobAusweich);
  assert.deepEqual(platzWaehlen(eigener, bobAusweich, 'archiv'), { art: 'nichts' });
  // Und die Sicherung verdrängt keinen Satz, der nicht aus dem Archiv kommt.
  assert.deepEqual(platzWaehlen(eigener, satz({ id: K, author_id: BOB }), 'sicherung'), {
    art: 'nichts'
  });
});

test('Fund 7: die Kopplung ist eigene Wahrheit wie die Sicherung und verdrängt einen fremden Archiv-Satz', () => {
  const bob = zeile(BOB, K, R_BOB);
  const ausKopplung = satz({ id: K, author_id: ALICE, content: 'vom alten Gerät' });
  assert.deepEqual(platzWaehlen(bob, ausKopplung, 'kopplung'), {
    art: 'verdraengen',
    satz: ausKopplung,
    verdraengt: bob
  });
});
