import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elterVon } from '../src/lib/navigation/elternRoute.ts';
import {
  anDerKante,
  ausgang,
  ausgeloest,
  AUSLOESE_WEG,
  FLICK_MIN_WEG,
  FLICK_TEMPO,
  folgeWeg,
  KANTE,
  tempoAus,
  verlauf
} from '../src/lib/navigation/kantenWischen.ts';

test('elterVon: dieselbe Tabelle wie die Android-Zurück-Taste', () => {
  assert.equal(elterVon('/app/guilds/7/channels/9'), '/app/rooms/7');
  assert.equal(elterVon('/app/rooms/7'), '/app/rooms');
  assert.equal(elterVon('/app/discover'), '/app/rooms');
  assert.equal(elterVon('/app/@me/42'), '/app/@me');
  assert.equal(elterVon('/app/me/sicherheit'), '/app/me');
});

test('elterVon: Wurzeln und Unbekanntes haben keinen Elter', () => {
  for (const wurzel of ['/app/@me', '/app/rooms', '/app/friends', '/app/me', '/app/server']) {
    assert.equal(elterVon(wurzel), null, wurzel);
  }
});

test('anDerKante: nur die ersten 20 px', () => {
  assert.equal(anDerKante(0), true);
  assert.equal(anDerKante(KANTE), true);
  assert.equal(anDerKante(KANTE + 1), false);
  assert.equal(anDerKante(-1), false);
});

test('verlauf: zu kurz bleibt offen, überwiegend senkrecht bricht ab', () => {
  assert.equal(verlauf(4, 3), 'offen');
  assert.equal(verlauf(30, 4), 'waagrecht');
  assert.equal(verlauf(12, 30), 'abgebrochen');
  assert.equal(verlauf(20, 20), 'abgebrochen'); // diagonal gehört dem Scrollen
  assert.equal(verlauf(-40, 2), 'abgebrochen'); // nach links
});

test('ausgeloest: erst ab der Strecke und nur waagrecht', () => {
  assert.equal(ausgeloest(AUSLOESE_WEG - 1, 0), false);
  assert.equal(ausgeloest(AUSLOESE_WEG, 5), true);
  assert.equal(ausgeloest(AUSLOESE_WEG + 40, 80), false);
});

test('folgeWeg: nie nach links, nie über die Breite', () => {
  assert.equal(folgeWeg(-30, 390), 0);
  assert.equal(folgeWeg(120, 390), 120);
  assert.equal(folgeWeg(500, 390), 390);
});

test('tempoAus: nur die Proben der letzten 100 ms zählen', () => {
  assert.equal(tempoAus([]), 0);
  assert.equal(tempoAus([{ x: 10, t: 0 }]), 0);
  // Langsamer Anfang (außerhalb des Fensters), schnelles Ende: 60 px in 50 ms.
  const proben = [
    { x: 0, t: 0 },
    { x: 20, t: 300 },
    { x: 80, t: 350 }
  ];
  assert.equal(tempoAus(proben), 60 / 50);
});

test('ausgang: ab einem Drittel der Breite gleitet die Seite hinaus', () => {
  assert.equal(ausgang(130, 5, 0, 390), 'hinaus');
  assert.equal(ausgang(129, 5, 0, 390), 'zurueckfedern');
});

test('ausgang: ein schneller Flick löst früh aus, aber nicht am Rand', () => {
  assert.equal(ausgang(FLICK_MIN_WEG, 0, FLICK_TEMPO, 390), 'hinaus');
  assert.equal(ausgang(FLICK_MIN_WEG - 1, 0, FLICK_TEMPO * 2, 390), 'zurueckfedern');
  assert.equal(ausgang(60, 0, FLICK_TEMPO - 0.01, 390), 'zurueckfedern');
});

test('ausgang: nicht mehr waagrecht federt immer zurück', () => {
  assert.equal(ausgang(200, 150, 2, 390), 'zurueckfedern');
  assert.equal(ausgang(-20, 0, 2, 390), 'zurueckfedern');
});
