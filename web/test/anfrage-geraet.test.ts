import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geraetFuerPlatz } from '../src/lib/remote/anfrageGeraet.ts';

test('Personen-Knopf am eigenen Go-Live: kein Gerät, obwohl eins im Kanal steht', () => {
  // Prüfbefund M2a: das Gerät sendet auf Platz 1, der Besitzer selbst auf 0.
  const geraete = [{ id: 'werkstatt', stream_slots: [1] }];
  assert.equal(geraetFuerPlatz(geraete, 0), null);
});

test('Platz eines Geräts: genau dieses Gerät, auch bei zwei Geräten im Kanal', () => {
  const geraete = [
    { id: 'werkstatt', stream_slots: [1] },
    { id: 'lager', stream_slots: [2, 3] },
  ];
  assert.equal(geraetFuerPlatz(geraete, 1), 'werkstatt');
  assert.equal(geraetFuerPlatz(geraete, 3), 'lager');
});

test('Gerät, das gerade nicht sendet, oder ohne Angabe: kein Gerät', () => {
  assert.equal(geraetFuerPlatz([{ id: 'werkstatt' }], 0), null);
  assert.equal(geraetFuerPlatz([{ id: 'werkstatt', stream_slots: [] }], 0), null);
  assert.equal(geraetFuerPlatz([], 0), null);
});
