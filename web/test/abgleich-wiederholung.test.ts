/**
 * Der Abgleich der Server-Liste gibt nach den Backoff-Stufen nicht mehr still
 * auf, sondern wartet auf Sichtbarwerden/Online (`abgleichWiederholung.ts`,
 * importfrei). Vorher blieb eine in der iOS-Hülle fehlgeschlagene Liste bis
 * zur nächsten Anmeldung leer (2026-10-17).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ABGLEICH_STUFEN_MS,
  abgleichWiederholung,
  type WiederholUmgebung,
} from '../src/lib/servers/abgleichWiederholung.ts';

function attrappe() {
  const timer = new Map<number, { f: () => void; ms: number }>();
  const hoerer = new Set<() => void>();
  let naechste = 1;
  const welt = { verdeckt: false };
  const umgebung: WiederholUmgebung = {
    setTimeout(f, ms) {
      const id = naechste++;
      timer.set(id, { f, ms });
      return id;
    },
    clearTimeout(griff) {
      timer.delete(griff as number);
    },
    verdeckt: () => welt.verdeckt,
    beiRueckkehr(h) {
      hoerer.add(h);
      return () => hoerer.delete(h);
    },
  };
  const feuereTimer = () => {
    const [[id, t]] = [...timer];
    timer.delete(id);
    t.f();
    return t.ms;
  };
  const melde = () => [...hoerer].forEach((h) => h());
  return { umgebung, timer, hoerer, welt, feuereTimer, melde };
}

test('erst die festen Stufen, mit fortlaufender Versuchsnummer', () => {
  const a = attrappe();
  const w = abgleichWiederholung(a.umgebung);
  const laeufe: number[] = [];
  w.planen(0, (n) => laeufe.push(n));
  assert.equal(a.feuereTimer(), ABGLEICH_STUFEN_MS[0]);
  w.planen(1, (n) => laeufe.push(n));
  assert.equal(a.feuereTimer(), ABGLEICH_STUFEN_MS[1]);
  assert.deepEqual(laeufe, [1, 2]);
  assert.equal(a.hoerer.size, 0);
});

test('nach der letzten Stufe: kein Timer, sondern Warten auf Rückkehr', () => {
  const a = attrappe();
  const w = abgleichWiederholung(a.umgebung);
  const laeufe: number[] = [];
  w.planen(ABGLEICH_STUFEN_MS.length, (n) => laeufe.push(n));
  assert.equal(a.timer.size, 0);
  assert.equal(a.hoerer.size, 1);

  a.welt.verdeckt = true; // Wechsel IN den Hintergrund zählt nicht
  a.melde();
  assert.deepEqual(laeufe, []);

  a.welt.verdeckt = false;
  a.melde();
  assert.deepEqual(laeufe, [0], 'Kette beginnt von vorn');
  assert.equal(a.hoerer.size, 0, 'nur einmal');
  a.melde();
  assert.deepEqual(laeufe, [0]);
});

test('abbrechen verwirft Timer und Hörer — ein frischer Abgleich ersetzt die Kette', () => {
  const a = attrappe();
  const w = abgleichWiederholung(a.umgebung);
  w.planen(0, () => assert.fail('darf nicht laufen'));
  w.abbrechen();
  assert.equal(a.timer.size, 0);
  w.planen(ABGLEICH_STUFEN_MS.length, () => assert.fail('darf nicht laufen'));
  w.abbrechen();
  assert.equal(a.hoerer.size, 0);
  a.melde();
});

test('serversStore.hydrateFromBackend plant über die Wiederholung', () => {
  const quelle = readFileSync(
    new URL('../src/lib/api/servers.svelte.ts', import.meta.url),
    'utf8',
  );
  const block = quelle.match(/async hydrateFromBackend\(attempt = 0\)[\s\S]*?\n  \}\n/);
  assert.ok(block, 'hydrateFromBackend nicht gefunden');
  assert.match(block[0], /this\._hydrateWiederholung\.abbrechen\(\);[\s\S]*?listMyInstances/);
  assert.match(block[0], /catch \{\s*this\._hydrateWiederholung\.planen\(attempt,/);
});
