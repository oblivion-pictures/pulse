import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { WACHE_ABSTAND_MS, bildWache } from '../src/lib/stream/bildWache.ts';

// Hypothese 2026-10-17 (TestFlight 11.1, Bild leer, Ton läuft): WebKit
// pausiert das stumme Video bei einer Audio-Unterbrechung, niemand startet es
// wieder. Die Wache startet nach — gedrosselt, nur vorn, abbaubar.

function aufbau() {
  const el = Object.assign(new EventTarget(), { paused: true });
  const seite = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let uhr = 0;
  const gruende: string[] = [];
  const wache = bildWache(el, seite, (g) => gruende.push(g), () => uhr);
  return { el, seite, wache, gruende, vor: (ms: number) => (uhr += ms) };
}

test('Pause am Video startet nach, mit Grund', () => {
  const a = aufbau();
  a.el.dispatchEvent(new Event('pause'));
  assert.deepEqual(a.gruende, ['pausiert_von_webkit']);
  a.wache.abbauen();
});

test('läuft das Video, tut die Wache nichts', () => {
  const a = aufbau();
  a.el.paused = false;
  a.el.dispatchEvent(new Event('suspend'));
  a.wache.anstossen('pausiert_nach_nativ_ton');
  assert.deepEqual(a.gruende, []);
  a.wache.abbauen();
});

test('im Hintergrund nie, die Rückkehr nach vorn stösst an', () => {
  const a = aufbau();
  a.seite.visibilityState = 'hidden';
  a.el.dispatchEvent(new Event('pause'));
  assert.deepEqual(a.gruende, []);
  a.seite.visibilityState = 'visible';
  a.seite.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(a.gruende, ['pausiert_nach_vordergrund']);
  a.wache.abbauen();
});

test('Drossel: innerhalb des Abstands kein zweiter Nachstart, danach einer', async () => {
  const a = aufbau();
  a.el.dispatchEvent(new Event('pause'));
  a.el.dispatchEvent(new Event('pause'));
  a.wache.anstossen('pausiert_nach_nativ_ton');
  assert.equal(a.gruende.length, 1);
  a.vor(WACHE_ABSTAND_MS);
  a.wache.anstossen('pausiert_nach_nativ_ton');
  assert.deepEqual(a.gruende, ['pausiert_von_webkit', 'pausiert_nach_nativ_ton']);
  a.wache.abbauen();
});

test('ein gedrosselter Anstoss wird nachgeholt, nicht verworfen', async () => {
  const el = Object.assign(new EventTarget(), { paused: true });
  const seite = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const gruende: string[] = [];
  const wache = bildWache(el, seite, (g) => gruende.push(g), Date.now, 20);
  wache.anstossen('a');
  wache.anstossen('b');
  assert.deepEqual(gruende, ['a']);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(gruende, ['a', 'b']);
  wache.abbauen();
});

test('abbauen löst alle Zuhörer und den Zeitgeber', async () => {
  const el = Object.assign(new EventTarget(), { paused: true });
  const seite = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const gruende: string[] = [];
  const wache = bildWache(el, seite, (g) => gruende.push(g), Date.now, 20);
  wache.anstossen('a');
  wache.anstossen('b');
  wache.abbauen();
  el.dispatchEvent(new Event('pause'));
  seite.dispatchEvent(new Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(gruende, ['a']);
});
