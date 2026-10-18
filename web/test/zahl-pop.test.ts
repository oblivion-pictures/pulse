/**
 * Zahl-Pop (Reaktions-Pille am Handy): ploppt nur bei einer echten Zunahme,
 * nie beim ersten Mounten, bei Abnahme, ausgeschaltet oder bei „Bewegung
 * reduzieren“. Ausgeführt mit Nodes Testläufer: `pnpm test:unit`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zahlPop } from '../src/lib/utils/zahlPop.ts';

function knoten() {
  const aufrufe: unknown[][] = [];
  const node = { animate: (...a: unknown[]) => void aufrufe.push(a) } as unknown as HTMLElement;
  return { node, aufrufe };
}

test('ploppt nur bei Zunahme', () => {
  const { node, aufrufe } = knoten();
  const a = zahlPop(node, { zahl: 1, aktiv: true });
  assert.equal(aufrufe.length, 0, 'Mounten animiert nicht');
  a.update({ zahl: 2, aktiv: true });
  assert.equal(aufrufe.length, 1);
  a.update({ zahl: 2, aktiv: true });
  a.update({ zahl: 1, aktiv: true });
  assert.equal(aufrufe.length, 1, 'gleich/weniger animiert nicht');
});

test('inaktiv zählt mit, animiert aber nie', () => {
  const { node, aufrufe } = knoten();
  const a = zahlPop(node, { zahl: 1, aktiv: false });
  a.update({ zahl: 2, aktiv: false });
  assert.equal(aufrufe.length, 0);
});
