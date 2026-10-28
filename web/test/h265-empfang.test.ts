/**
 * H265-Empfangsprüfung: entscheidet auf Linux, ob ein HEVC-Stream in der
 * Kachel laufen darf oder das eigene Fenster braucht (`WhepPlayer.svelte`).
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { h265Empfangbar } from '../src/lib/stream/h265Empfang.ts';

const codec = (mimeType: string) => ({ mimeType, clockRate: 90000 });

describe('h265Empfangbar', () => {
  test('H265 in der Empfangs-Liste → ja', () => {
    assert.equal(h265Empfangbar({ codecs: [codec('video/H264'), codec('video/H265')], headerExtensions: [] }), true);
  });

  test('Gross-/Kleinschreibung des MIME-Typs zählt nicht', () => {
    assert.equal(h265Empfangbar({ codecs: [codec('video/h265')], headerExtensions: [] }), true);
  });

  test('nur H264/AV1 → nein (Linux + NVIDIA ohne VaapiOnNvidiaGPUs)', () => {
    assert.equal(h265Empfangbar({ codecs: [codec('video/H264'), codec('video/AV1')], headerExtensions: [] }), false);
  });

  test('keine Fähigkeiten bekannt → nein, das eigene Fenster bleibt Pflicht', () => {
    assert.equal(h265Empfangbar(null), false);
    assert.equal(h265Empfangbar(undefined), false);
  });

  test('ohne WebRTC-API (Node) → nein', () => {
    assert.equal(h265Empfangbar(), false);
  });
});
