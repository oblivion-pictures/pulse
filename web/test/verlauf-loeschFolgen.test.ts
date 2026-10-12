import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anhangKandidaten, laufwerkDateien } from '../src/lib/verlauf/loeschFolgen.ts';
import { satzAnhangIds } from '../src/lib/verlauf/satz.ts';

// Gegenprüfung 2026-10-12, Fund 2: eine Löschung nahm die Anhänge des
// gelöschten Satzes mit, Bytes und Laufwerk-Datei, ohne zu fragen, wessen
// Anhänge das sind. Die Anhang-ID wählt der Absender frei. Den Ablauf gegen
// die echte Datenbank prüft `tests/e2e/verlauf-register.spec.ts`.

const ICH = '200';
const BOB = '300';
const MEIN_BILD = '501';
const SEIN_BILD = '502';

test('Laufwerk: eine fremde Löschung nimmt keine Datei aus der eigenen Sicherung mit', () => {
  // Bobs Satz trägt die ID meines Bildes — er hat sie von mir bekommen.
  const bobs = { autorId: BOB, anhaenge: [{ id: MEIN_BILD }, { id: SEIN_BILD }] };
  const verwaist = new Set([MEIN_BILD, SEIN_BILD]);
  assert.deepEqual(laufwerkDateien(bobs, ICH, verwaist), []);
});

test('Laufwerk: die eigene Löschung nimmt nur, was kein sichtbarer Satz mehr trägt', () => {
  const meiner = { autorId: ICH, anhaenge: [{ id: MEIN_BILD }, { id: SEIN_BILD }] };
  assert.deepEqual(laufwerkDateien(meiner, ICH, new Set([MEIN_BILD, SEIN_BILD])), [
    MEIN_BILD,
    SEIN_BILD
  ]);
  // Trägt ein anderer sichtbarer Satz das Bild noch, bleibt die Datei.
  assert.deepEqual(laufwerkDateien(meiner, ICH, new Set([SEIN_BILD])), [SEIN_BILD]);
  assert.deepEqual(laufwerkDateien(meiner, ICH, new Set()), []);
});

test('Kandidaten: alle gültigen Anhang-IDs der gelöschten Sätze, ohne Doppel', () => {
  const markiert = [
    { autorId: ICH, anhaenge: [{ id: MEIN_BILD }, { id: '../x' }, null, 'kaputt'] },
    { autorId: BOB, anhaenge: [{ id: MEIN_BILD }, { id: SEIN_BILD }] },
    { autorId: BOB }
  ];
  assert.deepEqual(anhangKandidaten(markiert), [MEIN_BILD, SEIN_BILD]);
});

test('satzAnhangIds: nur Anhänge mit gültiger Kennung — aus der ID wird ein Dateiname', () => {
  assert.deepEqual(satzAnhangIds({ anhaenge: [{ id: '7' }, { id: '../7' }, { id: 7 }, null] }), ['7']);
  assert.deepEqual(satzAnhangIds({}), []);
  assert.deepEqual(satzAnhangIds(undefined), []);
});
