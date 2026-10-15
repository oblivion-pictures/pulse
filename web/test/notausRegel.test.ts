/**
 * Der Schalter „Steuern erlauben" am Remote-Rechner (`remote/notausRegel.ts`):
 * nur verbieten, nie erlauben — und im Zweifel aus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steuernErlaubt } from '../src/lib/remote/notausRegel.ts';

const JETZT = 1_000_000;

test('an und ohne Ablauf: erlaubt', () => {
  assert.equal(steuernErlaubt({ geladen: true, aktiv: true, gueltigBis: null }, JETZT), true);
});

test('aus: nie erlaubt', () => {
  assert.equal(steuernErlaubt({ geladen: true, aktiv: false, gueltigBis: null }, JETZT), false);
});

test('noch nicht geladen: aus, auch wenn der Stand „an" sagt', () => {
  assert.equal(steuernErlaubt({ geladen: false, aktiv: true, gueltigBis: null }, JETZT), false);
});

test('alte befristete Freigabe: bis zum Ende an, danach aus', () => {
  assert.equal(steuernErlaubt({ geladen: true, aktiv: true, gueltigBis: JETZT + 1 }, JETZT), true);
  assert.equal(steuernErlaubt({ geladen: true, aktiv: true, gueltigBis: JETZT }, JETZT), false);
});
