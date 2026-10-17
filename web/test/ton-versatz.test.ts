import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ABSTAND_MS,
  MAX_MS,
  fensterMs,
  versatzEntscheiden,
  videoZaehler,
  whepHostErlaubt,
  whepPfad
} from '../src/lib/stream/tonVersatz.ts';

const lage = (o: Partial<Parameters<typeof versatzEntscheiden>[0]>) => ({
  videoMs: 0,
  tonMs: 0,
  aktuellMs: 0,
  vorschlagVorher: null,
  seitAenderungMs: ABSTAND_MS,
  ...o
});

test('Fenster statt Mittel seit Beginn: der Anlauf zählt nicht mit', () => {
  // 50 Pakete à 220 ms, dann 50 à 100 ms — das Fenster sieht nur die zweiten.
  const a = { summe: 50 * 0.22, anzahl: 50 };
  const b = { summe: a.summe + 50 * 0.1, anzahl: 100 };
  assert.equal(Math.round(fensterMs(a, b)!), 100);
  assert.equal(fensterMs(null, b), null);
  // Neue Sitzung (Zähler fing neu an) und leeres Fenster: keine Aussage.
  assert.equal(fensterMs(b, a), null);
  assert.equal(fensterMs(b, b), null);
});

test('Bildzähler aus einem getStats-Bericht', () => {
  const z = videoZaehler([
    { type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 9 },
    {
      type: 'inbound-rtp',
      kind: 'video',
      jitterBufferDelay: 12,
      jitterBufferEmittedCount: 100,
      totalDecodeTime: 0.5,
      framesDecoded: 100
    }
  ]);
  assert.deepEqual(z, { puffer: { summe: 12, anzahl: 100 }, dekodieren: { summe: 0.5, anzahl: 100 } });
  assert.equal(videoZaehler([{ type: 'codec' }]), null);
});

test('erst bei zwei übereinstimmenden Messungen, und nur ab der Schwelle', () => {
  // Bild 180 ms, Ton 60 ms: 120 ms Vorsprung des Tons.
  const erste = versatzEntscheiden(lage({ videoMs: 180, tonMs: 60 }));
  assert.deepEqual(erste, { vorschlag: 120, setzen: null });
  const zweite = versatzEntscheiden(lage({ videoMs: 185, tonMs: 60, vorschlagVorher: 120 }));
  assert.equal(zweite.setzen, 130);
  // Unter der Schwelle (kaum wahrnehmbar): nichts verzögern.
  assert.equal(versatzEntscheiden(lage({ videoMs: 90, tonMs: 50, vorschlagVorher: 0 })).setzen, null);
});

test('Ton später als das Bild: zurück auf 0, nie negativ', () => {
  const r = versatzEntscheiden(lage({ videoMs: 50, tonMs: 120, aktuellMs: 100, vorschlagVorher: 0 }));
  assert.deepEqual(r, { vorschlag: 0, setzen: 0 });
});

test('kleine Schritte, zu frühe Änderungen und Ausreisser bewegen nichts', () => {
  assert.equal(
    versatzEntscheiden(lage({ videoMs: 200, tonMs: 60, aktuellMs: 120, vorschlagVorher: 140 })).setzen,
    null
  );
  assert.equal(
    versatzEntscheiden(
      lage({ videoMs: 300, tonMs: 60, vorschlagVorher: 240, seitAenderungMs: ABSTAND_MS - 1 })
    ).setzen,
    null
  );
  // Ein Sprung zwischen zwei Messungen ist kein stabiler Wert.
  assert.equal(versatzEntscheiden(lage({ videoMs: 300, tonMs: 60, vorschlagVorher: 100 })).setzen, null);
});

test('nie über die Obergrenze', () => {
  const r = versatzEntscheiden(lage({ videoMs: 900, tonMs: 0, vorschlagVorher: MAX_MS }));
  assert.equal(r.setzen, MAX_MS);
});

test('Pfad ohne Lese-Token: dieselbe Übertragung erkennt man am Pfad', () => {
  const a = whepPfad('https://howispulse.com/whep/channel-1-2-abc/whep?token=x');
  const b = whepPfad('https://howispulse.com/whep/channel-1-2-abc/whep?token=y');
  assert.equal(a, b);
  assert.notEqual(a, whepPfad('https://howispulse.com/whep/channel-1-2-def/whep?token=x'));
});

test('nur eigene Pulse-Hosts, nur https (http nur lokal)', () => {
  const erlaubt = ['https://howispulse.com', 'heim.example.org', undefined];
  assert.ok(whepHostErlaubt('https://howispulse.com/whep/p/whep?token=x', erlaubt));
  assert.ok(whepHostErlaubt('https://heim.example.org/whep/p/whep', erlaubt));
  assert.ok(!whepHostErlaubt('https://evil.example.com/whep/p/whep', erlaubt));
  assert.ok(!whepHostErlaubt('http://howispulse.com/whep/p/whep', erlaubt));
  assert.ok(!whepHostErlaubt('kein-url', erlaubt));
  assert.ok(whepHostErlaubt('http://127.0.0.1:8889/p/whep', ['http://127.0.0.1:8889']));
  assert.ok(!whepHostErlaubt('http://127.0.0.1:8889/p/whep', ['http://127.0.0.1:5173']));
});
