import assert from 'node:assert/strict';
import { test } from 'node:test';

import { freigabeHinweis } from '../src/lib/remote/freigabeText.ts';

test('erteilt heißt: nichts zu erklären', () => {
  assert.equal(freigabeHinweis(''), null);
});

test('die beiden Freigaben führen an verschiedene Stellen', () => {
  const a = freigabeHinweis('bedienungshilfen');
  const b = freigabeHinweis('eingabeueberwachung:denied');
  assert.ok(a && b);
  assert.match(a.pfad, /Bedienungshilfen$/);
  assert.match(b.pfad, /Eingabeüberwachung$/);
  // Der eigentliche Fehler wäre, beide auf dieselbe Einstellung zu schicken —
  // dann sucht der Nutzer den Haken, der schon gesetzt ist.
  assert.notEqual(a.pfad, b.pfad);
});

test('beim Mithören steht der Grund dabei, warum es abgeschaltet bleibt', () => {
  const h = freigabeHinweis('eingabeueberwachung:denied');
  assert.ok(h);
  // Ohne diese Begründung sieht die Verweigerung wie Schikane aus.
  assert.match(h.erklaerung, /zurück/);
});

test('"ungefragt" verweist auf die Anfrage oder das Plus, "denied" auf den Schalter', () => {
  const mitAnfrage = freigabeHinweis('eingabeueberwachung:ungefragt', true);
  const ohneAnfrage = freigabeHinweis('eingabeueberwachung:ungefragt', false);
  const d = freigabeHinweis('eingabeueberwachung:denied', true);
  assert.ok(mitAnfrage && ohneAnfrage && d);
  assert.match(mitAnfrage.erklaerung, /Freigabe anfordern/);
  assert.match(ohneAnfrage.erklaerung, /Plus/);
  assert.doesNotMatch(d.erklaerung, /Freigabe anfordern|Plus/);
});

test('anfragbar nur, wo macOS noch einen Dialog zeigt', () => {
  // Bedienungshilfen: der Dialog kommt, solange Pulse nicht vertraut ist.
  assert.equal(freigabeHinweis('bedienungshilfen', true)?.anfragbar, true);
  // Eingabeüberwachung: nur solange nie gefragt — nach einem Nein schweigt
  // IOHIDRequestAccess, ein Knopf täte sichtbar nichts.
  assert.equal(freigabeHinweis('eingabeueberwachung:ungefragt', true)?.anfragbar, true);
  assert.equal(freigabeHinweis('eingabeueberwachung:denied', true)?.anfragbar, false);
  // Ohne Brücke (ältere Desktop-App) nie.
  assert.equal(freigabeHinweis('bedienungshilfen', false)?.anfragbar, false);
});

test('jede bekannte Freigabe nennt ihre Systemeinstellung', () => {
  assert.equal(freigabeHinweis('bedienungshilfen')?.einstellung, 'bedienungshilfen');
  assert.equal(freigabeHinweis('eingabeueberwachung:denied')?.einstellung, 'eingabeueberwachung');
  assert.equal(freigabeHinweis('irgendwas-neues:42')?.einstellung, null);
});

test('ein unbekannter Grund wird durchgereicht, nicht verschluckt', () => {
  const h = freigabeHinweis('irgendwas-neues:42');
  assert.ok(h);
  assert.match(h.erklaerung, /irgendwas-neues:42/);
});

test('kein Hinweis behauptet mehr, ein Update koste die Freigabe', () => {
  // Bis 2026-10-19 stand hier „nach einem Update entfernen und neu setzen" —
  // das galt für das ad-hoc signierte DMG. Mit Developer-ID-Signatur trifft es
  // nicht mehr zu und schickte den Nutzer grundlos in die Systemeinstellungen.
  for (const g of ['bedienungshilfen', 'eingabeueberwachung:denied']) {
    const h = freigabeHinweis(g);
    assert.ok(h, g);
    assert.doesNotMatch(h.erklaerung, /Update|neu gesetzt/, g);
  }
});
