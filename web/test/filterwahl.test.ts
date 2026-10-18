import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { filterziel, type Filterlage } from '../src/lib/voice/filterwahl.ts';

const lage = (teil: Partial<Filterlage> = {}): Filterlage => ({
  wunsch: 'rnnoise_gated',
  makeup: 1,
  ...teil
});

test('der Wunsch entscheidet', () => {
  assert.equal(filterziel(lage()), 'rnnoise_gated');
  assert.equal(filterziel(lage({ wunsch: 'off' })), 'keiner');
  assert.equal(filterziel(lage({ wunsch: 'off', makeup: 1.5 })), 'gain_only');
});

test('RNNoise bringt den Makeup-Pegel selbst mit', () => {
  assert.equal(filterziel(lage({ makeup: 1.5 })), 'rnnoise_gated');
});

test('Makeup genau 1 zaehlt als unveraendert', () => {
  assert.equal(filterziel(lage({ wunsch: 'off', makeup: 1 })), 'keiner');
  assert.equal(filterziel(lage({ wunsch: 'off', makeup: 0.5 })), 'gain_only');
});
