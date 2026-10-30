import test from 'node:test';
import assert from 'node:assert/strict';
import { baueBearbeitungsNutzlast, leseNachrichtNutzlast } from '../src/lib/krypto/nachrichtNutzlast.ts';

test('Bearbeitungs-Frame: Roundtrip und fail-closed', () => {
  // Die Absender-Bindung ist Pflicht (Security-Fix 2026-10-24).
  const bytes = baueBearbeitungsNutzlast('1788829404772578317', 'Neuer Text', {
    nutzer: 'user-9',
    geraet: 'geraet-7'
  });
  const gelesen = leseNachrichtNutzlast(bytes);
  assert.equal(gelesen.bearbeitung?.ziel, '1788829404772578317');
  assert.equal(gelesen.bearbeitung?.inhalt, 'Neuer Text');
  assert.equal(gelesen.text, '');
  // Fail-closed: ohne Ziel oder mit leerem Inhalt keine Bearbeitung
  const kaputt = leseNachrichtNutzlast(
    new TextEncoder().encode(JSON.stringify({ v: 1, text: '', bearbeitung: { inhalt: 'x' } }))
  );
  assert.equal(kaputt.bearbeitung, undefined);
  assert.equal(kaputt.text, '');
});
