import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HALTBARKEIT_MS,
  SPEICHER_SCHLUESSEL,
  abschickenMerken,
  abschickenVergessen,
  imSpeicherAnlegen,
  warAbgeschickt
} from '../src/lib/verbinden/abgeschickt.ts';
import type { Speicher } from '../src/lib/verbinden/gemerkt.ts';

function speicher(): Speicher & { daten: Map<string, string> } {
  const daten = new Map<string, string>();
  return {
    daten,
    getItem: (k) => daten.get(k) ?? null,
    setItem: (k, v) => void daten.set(k, v),
    removeItem: (k) => void daten.delete(k)
  };
}

const T0 = 1_760_000_000_000;

test('nichts abgeschickt, nichts gemerkt', () => {
  assert.equal(warAbgeschickt(speicher(), 'K7QM-2XDP', T0), false);
  assert.equal(warAbgeschickt(null, 'K7QM-2XDP', T0), false);
});

test('abgeschickt gilt für genau diesen Code, in jeder Schreibweise', () => {
  const s = speicher();
  abschickenMerken(s, 'k7qm 2xdp', T0);
  assert.equal(warAbgeschickt(s, 'K7QM-2XDP', T0 + 1000), true);
  assert.equal(warAbgeschickt(s, 'K7QM-2XDQ', T0 + 1000), false);
});

test('die Marke verfällt mit dem Code nach 15 Minuten und räumt sich dabei weg', () => {
  const s = speicher();
  abschickenMerken(s, 'K7QM-2XDP', T0);
  assert.equal(warAbgeschickt(s, 'K7QM-2XDP', T0 + HALTBARKEIT_MS - 1), true);
  assert.equal(warAbgeschickt(s, 'K7QM-2XDP', T0 + HALTBARKEIT_MS), false);
  assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false);
});

test('eine Marke aus der Zukunft oder aus Müll gilt nicht', () => {
  const s = speicher();
  s.daten.set(SPEICHER_SCHLUESSEL, JSON.stringify({ code: 'K7QM-2XDP', am: T0 + 5000 }));
  assert.equal(warAbgeschickt(s, 'K7QM-2XDP', T0), false);
  for (const roh of ['kein json', '"text"', 'null', '{"code":5,"am":"x"}', '{}']) {
    s.daten.set(SPEICHER_SCHLUESSEL, roh);
    assert.equal(warAbgeschickt(s, 'K7QM-2XDP', T0), false, roh);
  }
});

test('vergessen löscht die Marke', () => {
  const s = speicher();
  abschickenMerken(s, 'K7QM-2XDP', T0);
  abschickenVergessen(s);
  assert.equal(warAbgeschickt(s, 'K7QM-2XDP', T0), false);
});

test('ein Speicher, der wirft, bricht nichts ab', () => {
  const kaputt: Speicher = {
    getItem: () => {
      throw new Error('gesperrt');
    },
    setItem: () => {
      throw new Error('voll');
    },
    removeItem: () => {
      throw new Error('gesperrt');
    }
  };
  assert.doesNotThrow(() => abschickenMerken(kaputt, 'K7QM-2XDP', T0));
  assert.equal(warAbgeschickt(kaputt, 'K7QM-2XDP', T0), false);
  assert.doesNotThrow(() => abschickenVergessen(kaputt));
});

test('der Ersatzspeicher im Arbeitsspeicher verhält sich wie ein Storage', () => {
  const s = imSpeicherAnlegen();
  assert.equal(s.getItem('a'), null);
  s.setItem('a', '1');
  assert.equal(s.getItem('a'), '1');
  s.removeItem('a');
  assert.equal(s.getItem('a'), null);
});
