import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fernSofortAusMeldung, fernSofortUmgebung } from '../electron/player-fern-sofort.ts';

test('gespeicherter Haken wird zur Umgebungsvariable', () => {
  assert.equal(fernSofortUmgebung(true), '1');
  assert.equal(fernSofortUmgebung(false), '0');
});

test('nichts oder Unlesbares gespeichert: der Player nimmt seine Vorgabe', () => {
  // Ein String "0" aus einem von Hand bearbeiteten Store darf nicht als
  // „an" durchgehen (truthy) — lieber die Vorgabe als ein geratener Wert.
  for (const wert of [undefined, null, '0', 1, {}]) {
    assert.equal(fernSofortUmgebung(wert), undefined);
  }
});

test('nur die passende Meldung mit Wahrheitswert zählt', () => {
  assert.equal(fernSofortAusMeldung({ ev: 'player:fernSofort', an: false }), false);
  assert.equal(fernSofortAusMeldung({ ev: 'player:fernSofort', an: true }), true);
  assert.equal(fernSofortAusMeldung({ ev: 'player:fernSofort', an: 'ja' }), undefined);
  assert.equal(fernSofortAusMeldung({ ev: 'player:option', an: true }), undefined);
});
