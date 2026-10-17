import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elterVon } from '../src/lib/navigation/elternRoute.ts';
import {
  anDerKante,
  ausgeloest,
  AUSLOESE_WEG,
  KANTE,
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
