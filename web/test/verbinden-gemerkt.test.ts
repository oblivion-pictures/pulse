import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gemerkteVerbindung,
  gemerkteVerbindungVerwerfen,
  verbindungMerken,
  HALTBARKEIT_MS,
  SPEICHER_SCHLUESSEL,
  type Speicher
} from '../src/lib/verbinden/gemerkt.ts';

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

test('merken und wieder lesen, in Anzeigeform', () => {
  const s = speicher();
  verbindungMerken(s, 'k7qm2xdp', T0);
  assert.equal(gemerkteVerbindung(s, T0 + 1000), 'K7QM-2XDP');
});

test('ein ungültiger Code wird gar nicht erst gemerkt', () => {
  const s = speicher();
  verbindungMerken(s, 'quatsch', T0);
  assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false);
});

test('gilt 15 Minuten wie der Code an der Cloud, danach weg', () => {
  const s = speicher();
  verbindungMerken(s, 'K7QM-2XDP', T0);
  assert.equal(gemerkteVerbindung(s, T0 + HALTBARKEIT_MS - 1), 'K7QM-2XDP');
  assert.equal(gemerkteVerbindung(s, T0 + HALTBARKEIT_MS), null);
  assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false);
});

test('Zeitstempel in der Zukunft gilt nicht (Uhr verstellt)', () => {
  const s = speicher();
  verbindungMerken(s, 'K7QM-2XDP', T0 + 60_000);
  assert.equal(gemerkteVerbindung(s, T0), null);
});

test('kaputte oder manipulierte Einträge werden verworfen', () => {
  for (const roh of [
    'kein json',
    'null',
    '"text"',
    JSON.stringify({ code: 'K7QM-2XDU', gemerktAm: T0 }),
    JSON.stringify({ code: 7, gemerktAm: T0 }),
    JSON.stringify({ code: 'K7QM-2XDP', gemerktAm: 'gestern' })
  ]) {
    const s = speicher();
    s.daten.set(SPEICHER_SCHLUESSEL, roh);
    assert.equal(gemerkteVerbindung(s, T0), null, roh);
    assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false, roh);
  }
});

test('ein Speicher, der wirft, bricht nichts', () => {
  const wirft: Speicher = {
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
  verbindungMerken(wirft, 'K7QM-2XDP', T0);
  assert.equal(gemerkteVerbindung(wirft, T0), null);
  gemerkteVerbindungVerwerfen(wirft);
  assert.equal(gemerkteVerbindung(null, T0), null);
});

test('verwerfen löscht', () => {
  const s = speicher();
  verbindungMerken(s, 'K7QM-2XDP', T0);
  gemerkteVerbindungVerwerfen(s);
  assert.equal(gemerkteVerbindung(s, T0), null);
});

test('eigener Schlüssel, getrennt von der gemerkten Einladung', () => {
  assert.equal(SPEICHER_SCHLUESSEL, 'pulse.verbinden.gemerkt');
});
