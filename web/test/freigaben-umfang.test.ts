import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freigabenUmfang } from '../src/lib/devices/freigabenUmfang.ts';

const JETZT = Date.parse('2026-10-16T12:00:00Z');
const IN_1H = '2026-10-16T13:00:00Z';
const IN_6H = '2026-10-16T18:00:00Z';
const VORHIN = '2026-10-16T11:00:00Z';

test('leere Liste -> nicht jeder, Anzahl 0, kein Ende', () => {
  assert.deepEqual(freigabenUmfang([], JETZT), { jeder: false, anzahl: 0, ende: null });
});

test('everyone-Eintrag -> jeder; die übrigen zählen ohne ihn', () => {
  assert.deepEqual(
    freigabenUmfang(
      [
        { subject_type: 'everyone', expires_at: null },
        { subject_type: 'user', expires_at: IN_1H },
      ],
      JETZT,
    ),
    { jeder: true, anzahl: 1, ende: 'dauerhaft' },
  );
});

test('nur Nutzer/Rollen -> Anzahl der gültigen, Ende = spätester Ablauf', () => {
  assert.deepEqual(
    freigabenUmfang(
      [
        { subject_type: 'user', expires_at: IN_1H },
        { subject_type: 'role', expires_at: IN_6H },
        { subject_type: 'user', expires_at: IN_1H },
      ],
      JETZT,
    ),
    { jeder: false, anzahl: 3, ende: Date.parse(IN_6H) },
  );
});

test('abgelaufene Zeilen zählen nicht — auch kein abgelaufenes „jeder"', () => {
  assert.deepEqual(
    freigabenUmfang(
      [
        { subject_type: 'everyone', expires_at: VORHIN },
        { subject_type: 'user', expires_at: VORHIN },
        { subject_type: 'role', expires_at: IN_1H },
      ],
      JETZT,
    ),
    { jeder: false, anzahl: 1, ende: Date.parse(IN_1H) },
  );
});

test('nur abgelaufene -> wie leer', () => {
  assert.deepEqual(
    freigabenUmfang([{ subject_type: 'user', expires_at: VORHIN }], JETZT),
    { jeder: false, anzahl: 0, ende: null },
  );
});

test('unlesbarer Zeitpunkt gilt als abgelaufen', () => {
  assert.deepEqual(
    freigabenUmfang([{ subject_type: 'user', expires_at: 'kaputt' }], JETZT),
    { jeder: false, anzahl: 0, ende: null },
  );
});

test('eine dauerhafte Zeile macht das Ende dauerhaft, egal in welcher Reihenfolge', () => {
  assert.equal(
    freigabenUmfang(
      [
        { subject_type: 'user', expires_at: null },
        { subject_type: 'role', expires_at: IN_6H },
      ],
      JETZT,
    ).ende,
    'dauerhaft',
  );
  assert.equal(
    freigabenUmfang(
      [
        { subject_type: 'role', expires_at: IN_6H },
        { subject_type: 'user', expires_at: null },
      ],
      JETZT,
    ).ende,
    'dauerhaft',
  );
});
