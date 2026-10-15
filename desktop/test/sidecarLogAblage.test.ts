import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ohneAblageInhalt } from '../electron/sidecar-log-ablage.ts';

// "hunter2" in base64 — so steht ein kopiertes Passwort in einem `stueck`.
const GEHEIM = 'aHVudGVyMg==';

test('ein Stück des Players verliert seinen Inhalt, nicht seinen Ablauf', () => {
  // Genau so kommt die Zeile an: `player.ts` setzt den Vorsatz davor.
  const zeile = ohneAblageInhalt(
    `[pulse-player] {"ev":"ablage","data":{"d":"${GEHEIM}","i":0,"id":9,"n":1,"t":"stueck"},"session":1}`,
  );
  assert.ok(!zeile.includes(GEHEIM), zeile);
  assert.ok(zeile.startsWith('[pulse-player] {'), zeile);
  const e = JSON.parse(zeile.slice('[pulse-player] '.length));
  assert.deepEqual(e.data, { d: '***', i: 0, id: 9, n: 1, t: 'stueck' });
  assert.equal(e.session, 1);
});

test('dasselbe in der Feldfolge des Windows-Sidecars', () => {
  const zeile = ohneAblageInhalt(
    `{"data":{"d":"${GEHEIM}","i":0,"id":3,"n":1,"t":"stueck"},"ev":"ablage"}`,
  );
  assert.ok(!zeile.includes(GEHEIM), zeile);
});

test('Ankündigung, Abruf und Absage bleiben vollständig lesbar', () => {
  for (const roh of [
    '{"ev":"ablage","data":{"gen":6,"t":"neu","typ":"text"},"session":1}',
    '{"data":{"gen":1,"id":1,"t":"hol"},"ev":"ablage"}',
    '{"ev":"ablage","data":{"grund":"veraltet","id":4,"t":"leer"}}',
  ]) {
    assert.deepEqual(JSON.parse(ohneAblageInhalt(roh)), JSON.parse(roh));
  }
});

test('ein unbekanntes Feld gilt als Inhalt', () => {
  // Positivliste: ein künftiges Inhaltsfeld mit neuem Namen fällt von selbst heraus.
  const zeile = ohneAblageInhalt(`{"ev":"ablage","data":{"t":"datei","inhalt":"${GEHEIM}"}}`);
  assert.ok(!zeile.includes(GEHEIM), zeile);
});

test('eine nicht zerlegbare Ablage-Zeile wird nicht durchgereicht', () => {
  for (const roh of [
    `{"ev":"ablage","data":{"d":"${GEHEIM}"`,
    `[pulse-player] {"ev":"ablage","data":{"d":"${GEHEIM}"`,
    `[pulse-player] "ablage" ${GEHEIM}`,
  ]) {
    const zeile = ohneAblageInhalt(roh);
    assert.ok(!zeile.includes(GEHEIM), zeile);
  }
});

test('andere Zeilen bleiben unberührt', () => {
  const fps = '{"ev":"fps","value":60}';
  assert.equal(ohneAblageInhalt(fps), fps);
  const err = 'pulse-player: Sitzung 1: Ton — Unterlaeufe 5';
  assert.equal(ohneAblageInhalt(err), err);
  // Das Wort allein reicht nicht: nur ein Ereignis `ablage` wird umgeschrieben.
  const anders = '{"ev":"stats","ablage":"x"}';
  assert.equal(ohneAblageInhalt(anders), anders);
});
