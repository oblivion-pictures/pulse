import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { kamerasAbgleichen } from '../src/lib/voice/kameraAnsicht.ts';

// Native Kanalansicht (iOS) öffnet sich nur noch bei einer Kamera, einmal je
// Kamera-Start (Eigentümer-Entscheid 2026-10-17, Variante a).

const t = (identity: string, cameraOn: boolean) => ({ identity, cameraOn });
const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('ohne Kamera: nichts Neues', () => {
  const r = kamerasAbgleichen(new Set(), [t('a', false), t('b', false)]);
  assert.equal(r.neu, false);
  assert.equal(r.gesehen.size, 0);
});

test('eine Kamera geht an: neu, und beim nächsten Abgleich nicht mehr', () => {
  const erst = kamerasAbgleichen(new Set(), [t('a', true), t('b', false)]);
  assert.equal(erst.neu, true);
  const dann = kamerasAbgleichen(erst.gesehen, [t('a', true), t('b', false)]);
  assert.equal(dann.neu, false, 'dieselbe Kamera öffnet nach dem Wegwischen nicht wieder');
});

test('Kamera aus und wieder an zählt als neuer Start', () => {
  const an = kamerasAbgleichen(new Set(), [t('a', true)]);
  const aus = kamerasAbgleichen(an.gesehen, [t('a', false)]);
  assert.equal(aus.neu, false);
  assert.equal(aus.gesehen.size, 0);
  assert.equal(kamerasAbgleichen(aus.gesehen, [t('a', true)]).neu, true);
});

test('eine zweite Kamera neben einer laufenden ist neu', () => {
  const an = kamerasAbgleichen(new Set(), [t('a', true), t('b', false)]);
  assert.equal(kamerasAbgleichen(an.gesehen, [t('a', true), t('b', true)]).neu, true);
});

test('wer geht, fällt aus der Menge', () => {
  const an = kamerasAbgleichen(new Set(), [t('a', true)]);
  assert.equal(kamerasAbgleichen(an.gesehen, []).gesehen.size, 0);
});

test('der Spiegel öffnet beim Beitritt nur noch mit laufender Kamera', () => {
  const spiegel = lesen('../src/lib/voice/nativerRaum.svelte.ts');
  assert.match(spiegel, /z\.teilnehmer\.some\(\(t\) => t\.cameraOn\)/);
  assert.match(spiegel, /kamerasAbgleichen\(this\.#kameras, liste\)/);
});
