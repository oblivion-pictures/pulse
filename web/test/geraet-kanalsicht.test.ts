import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eintragWirkt, kanalSicht } from '../src/lib/devices/kanalSicht.ts';
import { Perm, type OverwriteSnapshot } from '../src/lib/permissions/bitfield.ts';

const EVERYONE = { id: 'r-everyone', position: 0, permissions: Perm.VIEW_CHANNEL, is_everyone: true };
const SCHNITT = { id: 'r-schnitt', position: 1, permissions: 0n, is_everyone: false };
const GAST = { id: 'r-gast', position: 2, permissions: 0n, is_everyone: false };

// Kanal nur für @Schnitt: @everyone verboten, Schnitt erlaubt.
const NUR_SCHNITT: OverwriteSnapshot[] = [
  { target_type: 0, target_id: 'r-everyone', allow: 0n, deny: Perm.VIEW_CHANNEL },
  { target_type: 0, target_id: 'r-schnitt', allow: Perm.VIEW_CHANNEL, deny: 0n },
];

function sicht(overwrites: OverwriteSnapshot[]) {
  return kanalSicht({
    mitglieder: [
      { userId: 'lena', rollenIds: ['r-schnitt'] },
      { userId: 'max', rollenIds: [] },
      { userId: 'tom', rollenIds: ['r-gast'] },
    ],
    rollen: [EVERYONE, SCHNITT, GAST],
    overwrites,
    besitzerId: null,
  });
}

test('offener Kanal: alle Mitglieder und Rollen sehen ihn', () => {
  const s = sicht([]);
  assert.deepEqual([...s.nutzer].sort(), ['lena', 'max', 'tom']);
  assert.deepEqual([...s.rollen].sort(), ['r-gast', 'r-schnitt']);
});

test('Kanal nur für eine Rolle: nur deren Träger und die Rolle selbst', () => {
  const s = sicht(NUR_SCHNITT);
  assert.deepEqual([...s.nutzer], ['lena']);
  assert.deepEqual([...s.rollen], ['r-schnitt']);
});

test('eintragWirkt: Nutzer und Rollen ohne Sicht wirken nicht', () => {
  const s = sicht(NUR_SCHNITT);
  assert.equal(eintragWirkt(s, { subject_type: 'user', subject_id: 'lena' }), true);
  assert.equal(eintragWirkt(s, { subject_type: 'user', subject_id: 'max' }), false);
  assert.equal(eintragWirkt(s, { subject_type: 'role', subject_id: 'r-schnitt' }), true);
  assert.equal(eintragWirkt(s, { subject_type: 'role', subject_id: 'r-gast' }), false);
});

test('eintragWirkt: „jeder" wirkt immer — er meint ohnehin nur, wer den Kanal sieht', () => {
  assert.equal(eintragWirkt(sicht(NUR_SCHNITT), { subject_type: 'everyone', subject_id: null }), true);
});

test('eintragWirkt: unbekannte Nutzer und fehlende Sicht warnen nicht', () => {
  const s = sicht(NUR_SCHNITT);
  // Nicht unter den geladenen Mitgliedern (Liste endet bei 100): unbekannt.
  assert.equal(eintragWirkt(s, { subject_type: 'user', subject_id: 'fremd' }), true);
  assert.equal(eintragWirkt(null, { subject_type: 'user', subject_id: 'max' }), true);
});

test('eine Nutzer-Abweichung gibt einem Einzelnen die Sicht zurück', () => {
  const s = sicht([
    ...NUR_SCHNITT,
    { target_type: 1, target_id: 'max', allow: Perm.VIEW_CHANNEL, deny: 0n },
  ]);
  assert.equal(eintragWirkt(s, { subject_type: 'user', subject_id: 'max' }), true);
});
