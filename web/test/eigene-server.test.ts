import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hatEigeneServer } from '../src/lib/selfhost/eigeneServer.ts';

const CLOUD = { isCloud: true, role: null };

test('nur die Cloud: kein eigener Server', () => {
  assert.equal(hatEigeneServer([CLOUD]), false);
  assert.equal(hatEigeneServer([]), false);
});

test('ein beigetretener fremder Server zählt nicht', () => {
  assert.equal(hatEigeneServer([CLOUD, { isCloud: false, role: 'member' }]), false);
});

test('ein eigener Server zählt, egal an welcher Stelle der Liste', () => {
  // Die Liste ist die des KONTOS, nicht die des aktiven Servers — die Reihenfolge
  // (und welcher davon gerade aktiv ist) spielt keine Rolle.
  assert.equal(hatEigeneServer([{ isCloud: false, role: 'owner' }, CLOUD]), true);
  assert.equal(
    hatEigeneServer([CLOUD, { isCloud: false, role: 'member' }, { isCloud: false, role: 'owner' }]),
    true
  );
});

test('unbekannte Rolle (Alt-Eintrag ohne Cloud-Abgleich) zählt nicht', () => {
  assert.equal(hatEigeneServer([CLOUD, { isCloud: false }, { isCloud: false, role: null }]), false);
});

test('eine Owner-Rolle an der Cloud ist kein eigener Server', () => {
  assert.equal(hatEigeneServer([{ isCloud: true, role: 'owner' }]), false);
});
