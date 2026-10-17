import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { STUMMER_PEGEL, StummerKontext, type KontextArt } from '../src/lib/stream/stummerKontext.ts';

// Nachbesserung 2026-10-17: kein Knopf — die Seite hält einen unhörbaren
// AudioContext, solange eine native Kachel spielt und die Seite vorn ist.

function fabrik() {
  const angelegt: (KontextArt & { offset: number; gestartet: boolean; zu: boolean })[] = [];
  const neu = () => {
    const k = {
      state: 'suspended',
      destination: {},
      offset: Number.NaN,
      gestartet: false,
      zu: false,
      resume() {
        k.state = 'running';
        return Promise.resolve();
      },
      close() {
        k.zu = true;
        k.state = 'closed';
        return Promise.resolve();
      },
      createConstantSource() {
        const q = {
          offset: { value: 0 },
          connect: () => undefined,
          start: () => {
            k.offset = q.offset.value;
            k.gestartet = true;
          }
        };
        return q;
      }
    };
    angelegt.push(k);
    return k;
  };
  return { angelegt, neu };
}

test('der Pegel ist ungleich null (sonst zählt WebKit ihn nicht) und unhörbar klein', () => {
  assert.ok(STUMMER_PEGEL > 0);
  assert.ok(STUMMER_PEGEL < 2 ** -24, 'unter einem halben 24-bit-Schritt');
});

test('läuft nur, solange gewollt UND sichtbar; wird geschlossen, nicht angehalten', async () => {
  const f = fabrik();
  const s = new StummerKontext(f.neu);
  assert.equal(s.laeuft, false);
  assert.equal(await s.bereit(), false);
  s.setzen({ gewollt: true });
  assert.equal(s.laeuft, true);
  assert.equal(await s.bereit(), true);
  assert.equal(f.angelegt[0].offset, STUMMER_PEGEL);
  assert.equal(f.angelegt[0].gestartet, true);
  s.setzen({ sichtbar: false });
  assert.equal(s.laeuft, false);
  assert.equal(f.angelegt[0].zu, true);
  assert.equal(await s.bereit(), false);
  s.setzen({ sichtbar: true });
  assert.equal(f.angelegt.length, 2, 'vorn wieder ein frischer Kontext');
  s.setzen({ gewollt: false });
  assert.equal(f.angelegt[1].zu, true);
  s.setzen({ gewollt: false });
  assert.equal(f.angelegt.length, 2);
});

test('unsichtbar gewollt: kein Kontext, bis die Seite vorn ist', () => {
  const f = fabrik();
  const s = new StummerKontext(f.neu);
  s.setzen({ sichtbar: false });
  s.setzen({ gewollt: true });
  assert.equal(f.angelegt.length, 0);
  s.setzen({ sichtbar: true });
  assert.equal(f.angelegt.length, 1);
});

test('ohne AudioContext oder bei einem Fehler: still nichts', async () => {
  const leer = new StummerKontext(() => null);
  leer.setzen({ gewollt: true });
  assert.equal(leer.laeuft, false);
  const kaputt = new StummerKontext(() => {
    throw new Error('nein');
  });
  kaputt.setzen({ gewollt: true });
  assert.equal(kaputt.laeuft, false);
  assert.equal(await kaputt.bereit(), false);
});
