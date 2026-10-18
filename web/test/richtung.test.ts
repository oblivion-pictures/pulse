import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUELTIG_MS,
  markiereZurueck,
  richtung,
  seitenKlasse,
  zuruecksetzen
} from '../src/lib/navigation/richtung.ts';

test('richtung: ohne Merker geht es vor', () => {
  zuruecksetzen();
  assert.equal(richtung(), 'vor');
});

test('richtung: der Merker gilt bis zum Zurücksetzen, nicht nur für den ersten Leser', () => {
  markiereZurueck('zurueck', 1000);
  assert.equal(richtung(1001), 'zurueck');
  assert.equal(richtung(1002), 'zurueck');
  zuruecksetzen();
  assert.equal(richtung(1003), 'vor');
});

test('richtung: ein vergessener Merker verfällt', () => {
  markiereZurueck('wischen', 1000);
  assert.equal(richtung(1000 + GUELTIG_MS), 'wischen');
  assert.equal(richtung(1000 + GUELTIG_MS + 1), 'vor');
  zuruecksetzen();
});

test('seitenKlasse: vor, zurück und Wischen wählen je Rolle', () => {
  assert.equal(seitenKlasse('vor', 'detail'), 'slide-rein');
  assert.equal(seitenKlasse('vor', 'wurzel'), 'bereich-blende');
  assert.equal(seitenKlasse('zurueck', 'detail'), 'slide-zurueck');
  assert.equal(seitenKlasse('zurueck', 'wurzel'), 'slide-zurueck');
  // Nach dem Wischen hat die Geste schon animiert: keine Doppel-Animation.
  assert.equal(seitenKlasse('wischen', 'detail'), '');
  assert.equal(seitenKlasse('wischen', 'wurzel'), '');
});
