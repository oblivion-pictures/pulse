import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEHLER_ABSTAND_MS,
  NACHLAUF_MS,
  createUploadAusloeser,
  type UploadGrund,
} from '../electron/diagnose-ausloeser.ts';

/** Handbetriebene Uhr: `vorspulen` führt fällige Planungen aus. */
function aufbau() {
  const gesendet: Array<[UploadGrund, number]> = [];
  let jetzt = 0;
  const plan: Array<{ fn: () => void; faellig: number; ab: boolean }> = [];
  const ausloeser = createUploadAusloeser(
    (grund, slot) => gesendet.push([grund, slot]),
    (fn, ms) => {
      const p = { fn, faellig: jetzt + ms, ab: false };
      plan.push(p);
      return () => {
        p.ab = true;
      };
    },
    () => jetzt,
  );
  const vorspulen = (ms: number) => {
    jetzt += ms;
    for (const p of plan) {
      if (!p.ab && p.faellig <= jetzt) {
        p.ab = true;
        p.fn();
      }
    }
  };
  return { ausloeser, gesendet, vorspulen };
}

test('sauberes Ende: stopped lädt sofort hoch, Grund stream_end', () => {
  const { ausloeser, gesendet } = aufbau();
  ausloeser({ ev: 'stopped' }, 0);
  assert.deepEqual(gesendet, [['stream_end', 0]]);
});

test('Windows/Linux: error ohne stopped lädt nach dem Nachlauf hoch', () => {
  const { ausloeser, gesendet, vorspulen } = aufbau();
  ausloeser({ ev: 'error' }, 0);
  vorspulen(NACHLAUF_MS - 1);
  assert.deepEqual(gesendet, [], 'vor Ablauf noch nichts');
  vorspulen(1);
  assert.deepEqual(gesendet, [['error', 0]]);
  vorspulen(10 * NACHLAUF_MS);
  assert.equal(gesendet.length, 1, 'genau ein Bericht');
});

test('macOS: error mit folgendem stopped gibt genau einen Bericht, sofort', () => {
  const { ausloeser, gesendet, vorspulen } = aufbau();
  ausloeser({ ev: 'error' }, 0);
  ausloeser({ ev: 'stopped' }, 0);
  assert.deepEqual(gesendet, [['error', 0]]);
  vorspulen(10 * NACHLAUF_MS);
  assert.equal(gesendet.length, 1, 'der geplante Upload ist abgesagt');
});

test('nach dem Fehlerbericht ist der nächste Stream wieder ein sauberes Ende', () => {
  const { ausloeser, gesendet, vorspulen } = aufbau();
  ausloeser({ ev: 'error' }, 0);
  vorspulen(NACHLAUF_MS);
  ausloeser({ ev: 'stopped' }, 0);
  assert.deepEqual(gesendet, [
    ['error', 0],
    ['stream_end', 0],
  ]);
});

test('ein zweites error vor Ablauf plant nicht doppelt', () => {
  const { ausloeser, gesendet, vorspulen } = aufbau();
  ausloeser({ ev: 'error' }, 0);
  vorspulen(NACHLAUF_MS / 2);
  ausloeser({ ev: 'error' }, 0);
  vorspulen(10 * NACHLAUF_MS);
  assert.deepEqual(gesendet, [['error', 0]]);
});

test('Slots sind getrennt: der Fehler des einen färbt das Ende des anderen nicht', () => {
  const { ausloeser, gesendet, vorspulen } = aufbau();
  ausloeser({ ev: 'error' }, 1);
  ausloeser({ ev: 'stopped' }, 0);
  vorspulen(NACHLAUF_MS);
  assert.deepEqual(gesendet, [
    ['stream_end', 0],
    ['error', 1],
  ]);
});

test('andere Ereignisse lösen nichts aus', () => {
  const { ausloeser, gesendet, vorspulen } = aufbau();
  for (const ev of ['state', 'fps', 'log', undefined]) ausloeser({ ev }, 0);
  vorspulen(10 * NACHLAUF_MS);
  assert.deepEqual(gesendet, []);
});

test('Fehlerschleife: höchstens ein Fehlerbericht je Slot und Minute', () => {
  const { ausloeser, gesendet, vorspulen } = aufbau();
  // Fehler, Neustart, wieder Fehler — mit und ohne folgendes `stopped`.
  ausloeser({ ev: 'error' }, 0);
  vorspulen(NACHLAUF_MS);
  ausloeser({ ev: 'error' }, 0);
  ausloeser({ ev: 'stopped' }, 0);
  ausloeser({ ev: 'error' }, 0);
  vorspulen(NACHLAUF_MS);
  assert.deepEqual(gesendet, [['error', 0]], 'innerhalb der Minute nur der erste');
  vorspulen(FEHLER_ABSTAND_MS);
  ausloeser({ ev: 'error' }, 0);
  vorspulen(NACHLAUF_MS);
  assert.deepEqual(gesendet, [
    ['error', 0],
    ['error', 0],
  ]);
});

test('die Drossel trifft nur Fehler: ein sauberes Ende geht immer', () => {
  const { ausloeser, gesendet, vorspulen } = aufbau();
  ausloeser({ ev: 'error' }, 0);
  vorspulen(NACHLAUF_MS);
  ausloeser({ ev: 'stopped' }, 0);
  ausloeser({ ev: 'stopped' }, 0);
  assert.deepEqual(gesendet, [
    ['error', 0],
    ['stream_end', 0],
    ['stream_end', 0],
  ]);
});

test('ein gedrosselter Fehler färbt das nächste saubere Ende nicht', () => {
  const { ausloeser, gesendet, vorspulen } = aufbau();
  ausloeser({ ev: 'error' }, 0);
  vorspulen(NACHLAUF_MS);
  ausloeser({ ev: 'error' }, 0);
  vorspulen(NACHLAUF_MS); // gedrosselt
  ausloeser({ ev: 'stopped' }, 0);
  assert.deepEqual(gesendet, [
    ['error', 0],
    ['stream_end', 0],
  ]);
});
