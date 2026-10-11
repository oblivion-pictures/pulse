import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zuSatz, sortierSchluessel, satzErgaenzen } from '../src/lib/verlauf/satz.ts';

test('Sortierschluessel ordnet nach Nachrichten-ID, nicht als Zahl', () => {
  // Snowflakes sind Zeichenketten, weil sie als Zahl nicht exakt sind. Ein
  // Schluessel, der sie ungepolstert aneinanderhaengt, sortiert "9" hinter
  // "10" — und der Verlauf stuende in falscher Reihenfolge da.
  const a = sortierSchluessel('k1', '9');
  const b = sortierSchluessel('k1', '10');
  assert.ok(a < b, `${a} muesste vor ${b} stehen`);
});

test('Sortierschluessel trennt Kanaele', () => {
  assert.notEqual(sortierSchluessel('k1', '5'), sortierSchluessel('k2', '5'));
});

test('zuSatz weist Fremdmaterial ab statt es abzulegen', () => {
  // fail-closed: was nicht wie eine Nachricht aussieht, wird nicht
  // gespeichert. Sonst faellt der Fehler erst beim Lesen auf, Wochen spaeter.
  assert.equal(zuSatz('k1', null, 'konto-a'), null);
  assert.equal(zuSatz('k1', {}, 'konto-a'), null);
  assert.equal(zuSatz('k1', { id: 5, content: 'x' }, 'konto-a'), null); // id muss Zeichenkette sein
});

test('zuSatz uebernimmt genau die gebrauchten Felder', () => {
  const satz = zuSatz('k1', {
    id: '42', author_id: '7', content: 'hallo',
    created_at: '2026-08-28T00:00:00Z', edited_at: null,
    attachments: [], unerwartet: 'wird nicht uebernommen',
  }, 'konto-a');
  assert.ok(satz);
  assert.equal(satz.nachrichtId, '42');
  assert.equal(satz.inhalt, 'hallo');
  assert.equal(satz.geloescht, false);
  assert.ok(!('unerwartet' in satz));
});

test('zuSatz traegt das uebergebene Konto in den Satz ein', () => {
  // Bughunt 2026-08-29, Befund 1: ohne dieses Feld sah ein zweites Konto auf
  // demselben Geraet den kompletten Bestand des ersten (s.
  // `verlauf-kontoFilter.test.ts`).
  const satz = zuSatz('k1', {
    id: '44', author_id: '7', content: 'hallo', created_at: '2026-08-28T00:00:00Z',
  }, 'konto-a');
  assert.ok(satz);
  assert.equal(satz.kontoId, 'konto-a');
});

test('eine geloeschte Nachricht bleibt als Grabstein', () => {
  // Sonst taucht sie beim naechsten Abgleich wieder auf.
  const satz = zuSatz('k1', {
    id: '43', author_id: '7', content: '',
    created_at: '2026-08-28T00:00:00Z', deleted_at: '2026-08-28T01:00:00Z',
    attachments: [],
  }, 'konto-a');
  assert.ok(satz);
  assert.equal(satz.geloescht, true);
});

// ── satzErgaenzen (2026-10-11): Nachschub ergänzt, ersetzt nicht ─────────────

function beispielSatz(felder: Record<string, unknown> = {}) {
  const s = zuSatz(
    'k1',
    {
      id: '42',
      author_id: '7',
      content: 'hallo',
      created_at: '2026-10-10T00:00:00Z',
      edited_at: null,
      attachments: [],
      ...felder
    },
    'konto-a'
  );
  assert.ok(s);
  return s;
}

test('satzErgaenzen: ein Grabstein bleibt einer, auch gegen einen reicheren Nachschub', () => {
  const stein = { ...beispielSatz(), geloescht: true };
  assert.equal(satzErgaenzen(stein, beispielSatz({ krypto_id: 'K', attachments: [{ id: 'a1' }] })), null);
});

test('satzErgaenzen: Inhalt, Bearbeitung und Reaktionen des liegenden Satzes gewinnen', () => {
  const liegend = {
    ...beispielSatz({ content: 'bearbeitet', edited_at: '2026-10-11T00:00:00Z' }),
    reaktionen: [{ emoji: 'x', userId: '9' }]
  };
  const neu = beispielSatz({ content: 'alt', krypto_id: 'K' });
  const ergebnis = satzErgaenzen(liegend, neu);
  assert.ok(ergebnis);
  assert.equal(ergebnis.inhalt, 'bearbeitet');
  assert.equal(ergebnis.bearbeitetAm, '2026-10-11T00:00:00Z');
  assert.deepEqual(ergebnis.reaktionen, [{ emoji: 'x', userId: '9' }]);
  assert.equal(ergebnis.kryptoId, 'K', 'die fehlende Kennung kommt dazu');
});

test('satzErgaenzen: die Kennung des liegenden Satzes wird nicht überschrieben, verschluesselt bleibt an', () => {
  // Der Archiv-Nachschub kam blind über einen Empfangs-Satz und nahm ihm die
  // kryptoId — mit ihr die Duplikat-Erkennung und den Lesestand-Anker.
  const liegend = beispielSatz({ krypto_id: 'K', verschluesselt: true });
  assert.equal(satzErgaenzen(liegend, beispielSatz({ verschluesselt: false })), null);
});

test('satzErgaenzen: fehlende Anhänge kommen dazu, bekannte nicht doppelt', () => {
  const liegend = beispielSatz({ attachments: [{ id: 'a1' }] });
  const ergebnis = satzErgaenzen(liegend, beispielSatz({ attachments: [{ id: 'a1' }, { id: 'a2' }] }));
  assert.ok(ergebnis);
  assert.deepEqual(
    ergebnis.anhaenge.map((a) => (a as { id: string }).id),
    ['a1', 'a2']
  );
});

test('satzErgaenzen: ein anderer Autor unter demselben Schlüssel überschreibt nichts', () => {
  assert.equal(satzErgaenzen(beispielSatz(), beispielSatz({ author_id: '8', krypto_id: 'K', content: 'fremd' })), null);
});

test('satzErgaenzen: nichts Neues heißt nichts zu schreiben', () => {
  assert.equal(satzErgaenzen(beispielSatz({ krypto_id: 'K' }), beispielSatz({ krypto_id: 'K' })), null);
});
