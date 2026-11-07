import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { aktivitaetZiele, meldetSichNachReady } from '../src/lib/ws/aktivitaetZiele.ts';

// Meldung 2026-11-07: Mit einem Heimserver als aktivem Server stand der
// eigene Status dauerhaft auf „abwesend" — das Lebenszeichen ging nur an den
// aktiven Server, den eigenen Status führt aber die Cloud.

test('Heimserver aktiv: Lebenszeichen geht an ihn UND an die Cloud', () => {
  assert.deepEqual(aktivitaetZiele('heim', 'cloud'), ['heim', 'cloud']);
});

test('Cloud aktiv: nur einmal an die Cloud', () => {
  assert.deepEqual(aktivitaetZiele('cloud', 'cloud'), ['cloud']);
});

test('ohne Cloud-Eintrag: nur der aktive Server', () => {
  assert.deepEqual(aktivitaetZiele('heim', null), ['heim']);
});

test('ohne aktiven Server: nur die Cloud', () => {
  assert.deepEqual(aktivitaetZiele(null, 'cloud'), ['cloud']);
  assert.deepEqual(aktivitaetZiele(null, null), []);
});

test('nach dem ready meldet sich die Cloud, auch im Hintergrund eines Heimservers', () => {
  assert.equal(meldetSichNachReady({ istCloud: true, istAktiv: false, verborgen: false }), true);
});

test('nach dem ready meldet sich der aktive Server', () => {
  assert.equal(meldetSichNachReady({ istCloud: false, istAktiv: true, verborgen: false }), true);
});

test('ein weiterer Server im Hintergrund meldet sich nicht', () => {
  assert.equal(meldetSichNachReady({ istCloud: false, istAktiv: false, verborgen: false }), false);
});

test('verborgenes Fenster meldet sich nicht (Tray, anderer Tab)', () => {
  assert.equal(meldetSichNachReady({ istCloud: true, istAktiv: true, verborgen: true }), false);
});
