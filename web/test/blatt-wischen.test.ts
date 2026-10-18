import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  imKopf,
  KOPF_HOEHE,
  senkrecht,
  tempo,
  versatz,
  weg
} from '../src/lib/components/mobile/blattWischen.ts';

test('imKopf: nur die obersten Pixel des Blattes ziehen', () => {
  assert.equal(imKopf(500, 500), true);
  assert.equal(imKopf(500 + KOPF_HOEHE, 500), true);
  assert.equal(imKopf(500 + KOPF_HOEHE + 1, 500), false);
  assert.equal(imKopf(499, 500), false);
});

test('senkrecht: waagrechte Gesten bleiben dem Inhalt', () => {
  assert.equal(senkrecht(2, 10), true);
  assert.equal(senkrecht(10, 2), false);
  assert.equal(senkrecht(5, 5), false);
});

test('versatz: nach unten 1:1, nach oben zäh', () => {
  assert.equal(versatz(120), 120);
  assert.equal(versatz(0), 0);
  assert.equal(versatz(-60), -10);
});

test('weg: weit genug oder schnell genug, nie nach oben', () => {
  assert.equal(weg(100, 400, 0), false); // 25 %, langsam: zurück
  assert.equal(weg(121, 400, 0), true); // über 30 %
  assert.equal(weg(60, 400, 0.8), true); // kurz, aber schnell
  assert.equal(weg(20, 400, 2), false); // Zucken
  assert.equal(weg(-50, 400, 3), false); // nach oben
});

test('tempo: über die letzten 100 ms, 0 ohne genug Proben', () => {
  assert.equal(tempo([]), 0);
  assert.equal(tempo([{ y: 0, t: 0 }]), 0);
  const proben = [
    { y: 0, t: 0 },
    { y: 10, t: 150 },
    { y: 30, t: 200 },
    { y: 70, t: 250 }
  ];
  // Fenster 100 ms: ab t=150 → (70-10)/(250-150) = 0,6
  assert.equal(tempo(proben), 0.6);
});
