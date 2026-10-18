import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEDER, FEDER_PUNKTE, bezier, federKurve } from '../src/lib/components/mobile/feder.ts';

test('Feder: Anfang, Ende, monoton und ohne Überschwingen', () => {
  assert.equal(federKurve(0), 0);
  assert.equal(federKurve(1), 1);
  let vorher = 0;
  for (let i = 1; i <= 100; i++) {
    const v = federKurve(i / 100);
    assert.ok(v >= vorher - 1e-9, `fällt bei ${i}`);
    assert.ok(v <= 1 + 1e-9);
    vorher = v;
  }
});

test('Feder: schneller Anlauf (ease-out) — nach 20 % Zeit schon über 40 % Weg', () => {
  assert.ok(federKurve(0.2) > 0.4);
});

test('bezier: lineare Kurve bleibt linear', () => {
  const linear = bezier(0, 0, 1, 1);
  for (const t of [0.1, 0.25, 0.5, 0.9]) assert.ok(Math.abs(linear(t) - t) < 1e-3);
});

test('FEDER: CSS-Wert passt zu den Punkten', () => {
  assert.equal(FEDER, `cubic-bezier(${FEDER_PUNKTE.join(',')})`);
  assert.equal(FEDER, 'cubic-bezier(0.32,0.72,0,1)');
});
