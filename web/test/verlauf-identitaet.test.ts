import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kanonischeId, nachrichtIdentitaet } from '../src/lib/verlauf/identitaet.ts';

// Eine verschlüsselte Nachricht liegt je Gerät unter einer anderen lokalen ID:
// beim Verfasser unter K (ohne kryptoId), beim Empfänger unter der
// Zustellungs-ID D mit kryptoId K, im Archiv unter K mit kryptoId K.
const K = '1760000000000123456';
const D = '120000000000000001';
const ALICE = '200';
const BOB = '300';

test('Verfasser-, Empfangs- und Archiv-Kopie haben dieselbe Identität', () => {
  const verfasser = nachrichtIdentitaet(ALICE, K, null);
  assert.equal(nachrichtIdentitaet(ALICE, D, K), verfasser);
  assert.equal(nachrichtIdentitaet(ALICE, K, K), verfasser);
});

test('Autor-Bindung: dieselbe Kennung eines anderen Autors ist eine andere Nachricht', () => {
  // Die Kennung wählt der Absender frei — Bob kann Alices K in seine
  // Nutzlast schreiben, wird dadurch aber nicht zu ihrem Duplikat.
  assert.notEqual(nachrichtIdentitaet(BOB, D, K), nachrichtIdentitaet(ALICE, K, null));
});

test('ein Satz ohne Autor ist nie dieselbe Nachricht wie einer mit', () => {
  assert.notEqual(nachrichtIdentitaet(undefined, K), nachrichtIdentitaet(ALICE, K));
  assert.equal(nachrichtIdentitaet(undefined, K), nachrichtIdentitaet(null, K));
});

test('kanonischeId: kryptoId, sonst die eigene ID — eine leere zählt als fehlend', () => {
  assert.equal(kanonischeId(D, K), K);
  assert.equal(kanonischeId(K, null), K);
  assert.equal(kanonischeId(K, undefined), K);
  assert.equal(kanonischeId(D, ''), D);
});
