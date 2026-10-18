import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { belegen, freigeben } from '../src/lib/components/mobile/inertZaehler.ts';

test('der erste Halter setzt inert, der letzte löst es', () => {
  const z = new Map<string, number>();
  assert.equal(belegen(z, 'app'), true);
  assert.equal(freigeben(z, 'app'), true);
  assert.equal(z.size, 0);
});

test('Übergang Blatt A -> B: A lässt los, B hält weiter', () => {
  const z = new Map<string, number>();
  assert.equal(belegen(z, 'app'), true); // A
  assert.equal(belegen(z, 'app'), false); // B legt seine Falle an
  assert.equal(freigeben(z, 'app'), false); // A schließt: inert bleibt
  assert.equal(freigeben(z, 'app'), true); // B schließt: jetzt lösen
});

test('Freigeben ohne Halter löst nichts', () => {
  const z = new Map<string, number>();
  assert.equal(freigeben(z, 'app'), false);
});
