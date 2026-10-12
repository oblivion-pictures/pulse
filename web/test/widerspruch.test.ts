import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WIDERSPRUCH_FEHLER,
  widerspruchFehler,
  widerspruchSchluessel
} from '../src/lib/selfhost/widerspruch.ts';

test('409 widerspruch_ohne_server: der Server antwortet unter der Adresse nicht', () => {
  assert.equal(
    widerspruchFehler(409, { detail: { code: 'widerspruch_ohne_server' } }),
    'ohne_server'
  );
});

test('404: kein eigener Eintrag oder kein lebendiger Antrag (mehr)', () => {
  assert.equal(widerspruchFehler(404, { detail: 'unbekannt' }), 'nicht_mehr');
});

test('503 verbinden_ausgelastet, 429, 401', () => {
  assert.equal(widerspruchFehler(503, { detail: 'verbinden_ausgelastet' }), 'ausgelastet');
  assert.equal(widerspruchFehler(429, null), 'gebremst');
  assert.equal(widerspruchFehler(401, { detail: 'missing session cookie' }), 'abgemeldet');
});

test('alles Unerwartete bleibt „sonst“ — auch ein 409 mit anderem Code', () => {
  const unerwartet: [number | null, unknown][] = [
    [null, null],
    [500, null],
    [503, { detail: 'anderes' }],
    [503, null],
    [409, { detail: { code: 'anderes' } }],
    [409, { detail: 'widerspruch_ohne_server' }],
    [409, 'text'],
    [403, { detail: 'verbinden_gesperrt' }]
  ];
  for (const [status, body] of unerwartet) {
    assert.equal(widerspruchFehler(status, body), 'sonst', `${status} ${JSON.stringify(body)}`);
  }
});

test('jeder Fehler hat einen Text in beiden Sprachen', () => {
  // Ein Schlüssel ohne Text fiele still auf den Sammeltext zurück — und wer
  // gerade nicht widersprechen kann, weil sein Server schweigt, erführe nicht,
  // woran es liegt.
  for (const sprache of ['de', 'en']) {
    const katalog = JSON.parse(
      readFileSync(new URL(`../messages/${sprache}.json`, import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    for (const art of WIDERSPRUCH_FEHLER) {
      const schluessel = widerspruchSchluessel(art);
      assert.equal(typeof katalog[schluessel], 'string', `${sprache}: ${schluessel}`);
    }
  }
});

test('die Texte der Übernahme-Karte tragen ihre Platzhalter in beiden Sprachen', () => {
  for (const sprache of ['de', 'en']) {
    const katalog = JSON.parse(
      readFileSync(new URL(`../messages/${sprache}.json`, import.meta.url), 'utf8')
    ) as Record<string, string>;
    assert.ok(katalog.meine_server_uebernahme_text.includes('{datum}'), sprache);
    for (const schluessel of [
      'meine_server_uebernahme_widersprechen',
      'meine_server_uebernahme_abgegeben',
      'meine_server_uebernahme_widersprochen'
    ]) {
      assert.equal(typeof katalog[schluessel], 'string', `${sprache}: ${schluessel}`);
    }
  }
});
