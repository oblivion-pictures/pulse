import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrAntwortDeuten } from '../src/lib/platform/qrAntwort.ts';

// iOS-Review V6: kamera_verweigert ist kein stiller Abbruch — aber auch kein
// zweiter Toast (die Hülle zeigt den Hinweis selbst).

test('ein gelesener Code kommt durch', () => {
  assert.deepEqual(qrAntwortDeuten({ code: 'ABC' }), { code: 'ABC', kameraVerweigert: false });
});

test('Abbruch ({code:null}) und älterer Bau bleiben ein einfacher Abbruch', () => {
  assert.deepEqual(qrAntwortDeuten({ code: null }), { code: null, kameraVerweigert: false });
  assert.deepEqual(qrAntwortDeuten({}), { code: null, kameraVerweigert: false });
  assert.deepEqual(qrAntwortDeuten(undefined), { code: null, kameraVerweigert: false });
});

test('grund kamera_verweigert wird als solcher erkannt', () => {
  assert.deepEqual(qrAntwortDeuten({ code: null, grund: 'kamera_verweigert' }), {
    code: null,
    kameraVerweigert: true
  });
});

test('ein Code gewinnt gegen einen Grund; fremde Gründe zählen nicht', () => {
  assert.equal(qrAntwortDeuten({ code: 'X', grund: 'kamera_verweigert' }).kameraVerweigert, false);
  assert.equal(qrAntwortDeuten({ code: null, grund: 'etwas_anderes' }).kameraVerweigert, false);
});
