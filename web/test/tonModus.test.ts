import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zielModus } from '../src/lib/platform/tonModus.ts';

test('nichts laeuft -> Session aus', () => {
	assert.equal(zielModus(0), 'aus');
});

test('Stream-Ton -> wiedergabe', () => {
	assert.equal(zielModus(1), 'wiedergabe');
	assert.equal(zielModus(2), 'wiedergabe');
});

// --- Bughunt 2026-10-11: K2 (nativer Raum) und G2 (Merken erst nach Gelingen)

import { NACH_NATIVEM_RAUM, tonSchritt } from '../src/lib/platform/tonModus.ts';

const schritt = (teil: Partial<Parameters<typeof tonSchritt>[0]> = {}) =>
  tonSchritt({ ziel: 'wiedergabe', angewandt: 'aus', nativerRaum: false, ...teil });

test('K2: steht der native Raum, wird die Session NICHT angefasst — weder Stream noch Abmelden', () => {
  // Stream an waehrend des nativen Sprachkanals: vorher `.playback` auf
  // LiveKits Session (kein Eingang mehr).
  assert.equal(schritt({ ziel: 'wiedergabe', angewandt: 'aus', nativerRaum: true }), 'nichts');
  // Stream wieder zu: vorher `setActive(false)` mitten im Gespraech.
  assert.equal(schritt({ ziel: 'aus', angewandt: 'wiedergabe', nativerRaum: true }), 'nichts');
});

test('K2: nach dem nativen Raum gilt die Session als aus — ein laufender Stream wird neu eingerichtet', () => {
  // LiveKit deaktiviert beim Verlassen selbst. Laeuft noch ein Stream, muss
  // er seine Session zurueckbekommen; laeuft nichts, bleibt es dabei.
  assert.equal(NACH_NATIVEM_RAUM, 'aus');
  assert.equal(schritt({ ziel: 'wiedergabe', angewandt: NACH_NATIVEM_RAUM }), 'anwenden');
  assert.equal(schritt({ ziel: 'aus', angewandt: NACH_NATIVEM_RAUM }), 'nichts');
});

test('G2: was nicht angewandt ist, wird beim naechsten Anlass erneut versucht', () => {
  // `angewandt` bleibt nach einem Fehlschlag auf dem alten Wert — gleiches
  // Ziel beim naechsten Anlass ergibt also wieder `anwenden`.
  assert.equal(schritt({ ziel: 'wiedergabe', angewandt: 'aus' }), 'anwenden');
  assert.equal(schritt({ ziel: 'wiedergabe', angewandt: 'wiedergabe' }), 'nichts');
});
