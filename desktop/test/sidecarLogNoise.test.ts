import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FPS_SAMPLE_MS, createNoiseFilter } from '../electron/sidecar-log-noise.ts';

const FPS = '{"ev":"fps","fps":59.99,"uptime_s":12.3}';
const STATE = '{"ev":"state","running":true,"state":"live","uptime_s":0.0}';
const ERROR = '{"ev":"error","message":"av_buffersrc_add_frame_flags failed (rc=-22)"}';

test('fps: erste Zeile durch, Rest der Minute unterdrückt, danach wieder eine', () => {
  const f = createNoiseFilter();
  assert.equal(f('out', FPS, 1_000), false, 'die erste Stichprobe muss durch');
  assert.equal(f('out', FPS, 2_000), true);
  assert.equal(f('out', FPS, 1_000 + FPS_SAMPLE_MS - 1), true, 'knapp vor Ablauf noch stumm');
  assert.equal(f('out', FPS, 1_000 + FPS_SAMPLE_MS), false, 'nach Ablauf wieder eine');
  assert.equal(f('out', FPS, 1_000 + FPS_SAMPLE_MS + 1), true, 'Fenster beginnt neu');
});

test('state öffnet das Fenster erneut — auch ein kurzer Stream belegt Frames', () => {
  const f = createNoiseFilter();
  assert.equal(f('out', FPS, 0), false);
  assert.equal(f('out', FPS, 5_000), true, 'innerhalb der Minute stumm');
  assert.equal(f('out', STATE, 6_000), false, 'state selbst wird nie unterdrückt');
  assert.equal(f('out', FPS, 7_000), false, 'nach dem state-Übergang wieder eine Stichprobe');
});

test('alles außer fps bleibt unangetastet — auch im stdout-Strom', () => {
  const f = createNoiseFilter();
  for (const now of [0, 1, 2, 3]) {
    assert.equal(f('out', ERROR, now), false, 'Fehlerzeilen nie unterdrücken');
    assert.equal(f('out', '{"ev":"log","line":"[stream] Encode-Pfad: VAAPI"}', now), false);
  }
});

test('stderr und lifecycle sind tabu — dort steht FFmpegs Begründung', () => {
  const f = createNoiseFilter();
  // Selbst eine Zeile, die wie fps aussieht, darf auf stderr nicht wegfallen.
  assert.equal(f('err', FPS, 0), false);
  assert.equal(f('err', FPS, 1), false);
  assert.equal(f('lifecycle', FPS, 2), false);
});

test('gemessenes Rauschverhältnis: aus 60 fps/min wird 1', () => {
  const f = createNoiseFilter();
  let durch = 0;
  // Eine Stunde Stream bei 1 fps-Zeile/Sekunde.
  for (let s = 0; s < 3600; s++) if (!f('out', FPS, s * 1_000)) durch++;
  assert.equal(durch, 60, 'genau eine Stichprobe pro Minute');
});

// Fernsteuerung (2026-10-14): die Quittungen auf Eingaben und die
// Zeigerform-Meldungen leerten den Vorrat der Drossel — 12 443 bzw. 1 600
// Zeilen in einer Sitzung. Zeilen in der Form jener Sitzung (Werte erfunden).
const QUITTUNG = '{"id":4711,"ok":true,"processed":3,"state":"live"}';
const QUITTUNG_HOST = '{"id":4712,"ok":true,"processed":0,"state":"host_active"}';
const QUITTUNG_MASKIERT = '{"id":4714,"ok":true,"processed":0,"state":"masked"}';
const ABGELEHNT = '{"error":"…","id":4713,"ok":false}';
const ZEIGER = '{"ev":"remote_pointer","shape":"default","slot":0}';
const ZEIGER_IM_BILD = '{"ev":"remote_pointer_in_frame","in_frame":false,"slot":0}';

test('Eingabe-Quittungen: eine Stichprobe je Minute, wie fps', () => {
  const f = createNoiseFilter();
  let durch = 0;
  // Eine Minute Fernsteuerung bei 125 Anfragen je Sekunde.
  for (let i = 0; i < 125 * 60; i++) if (!f('out', QUITTUNG, i * 8)) durch++;
  assert.equal(durch, 1);
  assert.equal(f('out', QUITTUNG, FPS_SAMPLE_MS), false, 'nach der Minute die nächste');
});

test('ein neuer Zustand der Quittung steht sofort im Log', () => {
  const f = createNoiseFilter();
  assert.equal(f('out', QUITTUNG, 0), false);
  assert.equal(f('out', QUITTUNG, 10), true);
  assert.equal(f('out', QUITTUNG_MASKIERT, 20), false, 'live -> masked erklärt fehlende Eingaben');
  assert.equal(f('out', QUITTUNG_HOST, 30), false);
  assert.equal(f('out', QUITTUNG_HOST, 40), true, 'danach wird auch dieser Zustand ausgedünnt');
});

test('remote_pointer_in_frame ist keine Zeigerform-Stichprobe', () => {
  const f = createNoiseFilter();
  assert.equal(f('out', ZEIGER, 0), false);
  for (const now of [1, 2, 3]) assert.equal(f('out', ZEIGER_IM_BILD, now), false);
});

test('eine abgelehnte Eingabe geht immer durch', () => {
  const f = createNoiseFilter();
  for (const now of [0, 1, 2]) assert.equal(f('out', ABGELEHNT, now), false);
});

test('Zeigerformen: eine Stichprobe je Minute', () => {
  const f = createNoiseFilter();
  assert.equal(f('out', ZEIGER, 0), false);
  assert.equal(f('out', ZEIGER, 500), true);
  assert.equal(f('out', ZEIGER, FPS_SAMPLE_MS), false);
});

test('die Sorten teilen sich kein Fenster', () => {
  const f = createNoiseFilter();
  assert.equal(f('out', FPS, 0), false);
  assert.equal(f('out', QUITTUNG, 1), false, 'die erste Quittung trotz frischer fps-Stichprobe');
  assert.equal(f('out', ZEIGER, 2), false, 'die erste Zeigerform ebenso');
  assert.equal(f('out', QUITTUNG, 3), true);
});

test('state öffnet auch das Fenster der Quittungen erneut', () => {
  const f = createNoiseFilter();
  assert.equal(f('out', QUITTUNG, 0), false);
  assert.equal(f('out', QUITTUNG, 10), true);
  assert.equal(f('out', STATE, 20), false);
  assert.equal(f('out', QUITTUNG, 30), false);
});
