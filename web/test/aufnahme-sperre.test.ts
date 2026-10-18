import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { aufnahmeGesperrt } from '../src/lib/platform/aufnahmeSperre.ts';
import { mikrofonBeiDerHuelleMelden } from '../src/lib/platform/mikrofonBeiDerHuelle.ts';

test('ohne Mikrofon bei der Hülle ist nichts gesperrt (Desktop, Browser, Android)', () => {
  mikrofonBeiDerHuelleMelden(false);
  for (const art of ['ton', 'video', 'foto'] as const) assert.equal(aufnahmeGesperrt(art), false);
});

test('Mikrofon bei der Hülle: Sprachnachricht und Video gesperrt, Foto frei', () => {
  mikrofonBeiDerHuelleMelden(true);
  try {
    assert.equal(aufnahmeGesperrt('ton'), true);
    assert.equal(aufnahmeGesperrt('video'), true);
    assert.equal(aufnahmeGesperrt('foto'), false);
  } finally {
    mikrofonBeiDerHuelleMelden(false);
  }
  assert.equal(aufnahmeGesperrt('ton'), false);
});
