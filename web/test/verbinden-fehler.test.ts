import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BEFUNDE,
  ausgangUngewiss,
  meldungsSchluessel,
  verbindenFehler,
  type VerbindenFehler
} from '../src/lib/verbinden/fehler.ts';

test('404 heißt: Code unbekannt, abgelaufen oder schon entschieden', () => {
  assert.deepEqual(verbindenFehler(404, { detail: 'unbekannt' }), { art: 'unbekannt' });
});

test('404 nach einem eigenen Klick heißt: nachsehen, nicht „Code ungültig“', () => {
  // Die Cloud antwortet auf einen zweiten Versuch 404, obwohl der erste gewirkt
  // hat (Bestätigen dauert bis ~30 s, ein Doppelklick oder Neuladen kommt dazwischen).
  assert.deepEqual(verbindenFehler(404, { detail: 'unbekannt' }, true), { art: 'nachsehen' });
  // Alles andere bleibt, was es ist.
  assert.deepEqual(verbindenFehler(429, null, true), { art: 'gebremst' });
});

test('401 heißt: die Anmeldung ist weg', () => {
  assert.deepEqual(verbindenFehler(401, { detail: 'missing session cookie' }), {
    art: 'abgemeldet'
  });
});

test('die drei Ablehnungen beim Bestätigen', () => {
  assert.deepEqual(verbindenFehler(403, { detail: 'verbinden_gesperrt' }), {
    art: 'verbinden_gesperrt'
  });
  assert.deepEqual(verbindenFehler(409, { detail: 'zu_viele_server' }), {
    art: 'zu_viele_server'
  });
  assert.deepEqual(
    verbindenFehler(409, { detail: { code: 'nachweis_fehlt', befund: 'zertifikat' } }),
    { art: 'nachweis_fehlt', befund: 'zertifikat' }
  );
});

test('ein unbekannter Befund bleibt ein Nachweis-Fehler ohne Einzelheit', () => {
  assert.deepEqual(
    verbindenFehler(409, { detail: { code: 'nachweis_fehlt', befund: 'neu' } }),
    { art: 'nachweis_fehlt', befund: null }
  );
});

test('Übernahme gesperrt trägt das Ende der Sperre', () => {
  assert.deepEqual(
    verbindenFehler(409, { detail: { code: 'uebernahme_gesperrt', bis: '2026-11-10T12:00:00Z' } }),
    { art: 'uebernahme_gesperrt', bis: '2026-11-10T12:00:00Z' }
  );
});

test('Übernahme gesperrt ohne lesbares Ende bleibt gesperrt, nur ohne Datum', () => {
  for (const bis of [undefined, null, 5, '']) {
    assert.deepEqual(
      verbindenFehler(409, { detail: { code: 'uebernahme_gesperrt', bis } }),
      { art: 'uebernahme_gesperrt', bis: null },
      String(bis)
    );
  }
});

test('gesperrte Adresse, ausgelastete Prüfung, Verbinden nicht verfügbar', () => {
  assert.deepEqual(verbindenFehler(403, { detail: 'instance_suspended' }), {
    art: 'adresse_gesperrt'
  });
  assert.deepEqual(verbindenFehler(503, { detail: 'verbinden_ausgelastet' }), {
    art: 'ausgelastet'
  });
  assert.deepEqual(verbindenFehler(503, { detail: 'verbinden_nicht_verfuegbar' }), {
    art: 'nicht_verfuegbar'
  });
});

test('Bremse und alles Unerwartete', () => {
  assert.deepEqual(verbindenFehler(429, null), { art: 'gebremst' });
  const unerwartet: [number | null, unknown][] = [
    [500, null],
    [503, { detail: 'anderes' }],
    [null, null],
    [403, { detail: 'anderes' }],
    [409, 'text'],
    [409, { detail: { code: 'anderes' } }]
  ];
  for (const [status, body] of unerwartet) {
    assert.deepEqual(verbindenFehler(status, body), { art: 'sonst' }, String(status));
  }
});

test('unbekannt, nachsehen und abgemeldet sind eigene Zustände, kein Hinweistext', () => {
  assert.equal(meldungsSchluessel({ art: 'unbekannt' }), null);
  assert.equal(meldungsSchluessel({ art: 'nachsehen' }), null);
  assert.equal(meldungsSchluessel({ art: 'abgemeldet' }), null);
});

test('nur eine Antwort, die nichts über den Ausgang sagt, lässt ihn offen', () => {
  // Kein Netz, 5xx, Proxy-Zeitüberschreitung: der Klick kann gewirkt haben.
  assert.equal(ausgangUngewiss({ art: 'sonst' }), true);
  // Eine ausdrückliche Ablehnung der Cloud heißt: nichts ist passiert.
  const klar: VerbindenFehler[] = [
    { art: 'nachweis_fehlt', befund: null },
    { art: 'zu_viele_server' },
    { art: 'verbinden_gesperrt' },
    { art: 'uebernahme_gesperrt', bis: null },
    { art: 'adresse_gesperrt' },
    { art: 'ausgelastet' },
    { art: 'nicht_verfuegbar' },
    { art: 'gebremst' },
    { art: 'abgemeldet' }
  ];
  for (const f of klar) assert.equal(ausgangUngewiss(f), false, f.art);
});

test('jeder Hinweis hat einen Text in beiden Sprachen', () => {
  // Ein Schlüssel ohne Text fiele still auf „Etwas ist schiefgegangen“ zurück
  // — und der Betreiber erführe nicht, dass sein Proxy den Nachweis schluckt.
  const faelle: VerbindenFehler[] = [
    { art: 'nachweis_fehlt', befund: null },
    ...BEFUNDE.map((befund) => ({ art: 'nachweis_fehlt' as const, befund })),
    { art: 'zu_viele_server' },
    { art: 'verbinden_gesperrt' },
    { art: 'uebernahme_gesperrt', bis: '2026-11-10T12:00:00Z' },
    { art: 'uebernahme_gesperrt', bis: null },
    { art: 'adresse_gesperrt' },
    { art: 'ausgelastet' },
    { art: 'nicht_verfuegbar' },
    { art: 'gebremst' },
    { art: 'sonst' }
  ];
  for (const sprache of ['de', 'en']) {
    const katalog = JSON.parse(
      readFileSync(new URL(`../messages/${sprache}.json`, import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    for (const f of faelle) {
      const schluessel = meldungsSchluessel(f);
      assert.ok(schluessel, JSON.stringify(f));
      assert.equal(typeof katalog[schluessel], 'string', `${sprache}: ${schluessel}`);
    }
  }
});

test('Texte mit Datum nennen den Platzhalter in beiden Sprachen', () => {
  // Fehlte {datum}, bliebe die Sperrfrist unsichtbar; „{datum}“ ohne Wert
  // würde der Seite dagegen als Rohtext auffallen — beides wäre still falsch.
  for (const sprache of ['de', 'en']) {
    const katalog = JSON.parse(
      readFileSync(new URL(`../messages/${sprache}.json`, import.meta.url), 'utf8')
    ) as Record<string, string>;
    for (const schluessel of ['verbinden_uebernahme_gesperrt', 'verbinden_uebernahme_beantragt']) {
      assert.match(katalog[schluessel], /\{datum\}/, `${sprache}: ${schluessel}`);
    }
  }
});
