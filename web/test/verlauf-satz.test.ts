import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  zuSatz,
  sortierSchluessel,
  satzErgaenzen,
  nachSchluesselVerdichten
} from '../src/lib/verlauf/satz.ts';

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

test('zuSatz legt nur ab, was eine Kennung traegt (Gegenpruefung 2026-10-12, Fund 1)', () => {
  // Die letzte Wand vor dem Ablegen: eine frei gewaehlte ID wie `"x"` brachte
  // den Sicherungs-Leser zum Absturz.
  const roh = { author_id: '7', content: 'x', created_at: '2026-08-28T00:00:00Z' };
  assert.equal(zuSatz('k1', { ...roh, id: 'x' }, 'konto-a'), null);
  assert.equal(zuSatz('k1', { ...roh, id: '0042' }, 'konto-a'), null);
  // Kennung und Antwortbezug, die keine sind, fallen weg — der Satz bleibt.
  const satz = zuSatz('k1', { ...roh, id: '42', krypto_id: 'x', reply_to_id: '../y' }, 'konto-a');
  assert.ok(satz);
  assert.equal(satz.kryptoId, null);
  assert.equal(satz.antwortAufId, null);
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

// Kennungen in der Form echter IDs — `zuSatz` nimmt seit Fund 1 der zweiten
// Gegenprüfung keine andere `krypto_id` mehr an.
const K = '1760000000000123456';
const X = '1760000000000654321';

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
  const reicher = beispielSatz({ krypto_id: K, attachments: [{ id: '501' }] });
  assert.equal(satzErgaenzen(stein, reicher, 'sicherung'), null);
  assert.equal(satzErgaenzen(stein, reicher, 'archiv'), null);
});

test('satzErgaenzen: Inhalt, Bearbeitung und Reaktionen des liegenden Satzes gewinnen', () => {
  const liegend = {
    ...beispielSatz({ content: 'bearbeitet', edited_at: '2026-10-11T00:00:00Z' }),
    reaktionen: [{ emoji: 'x', userId: '9' }]
  };
  const neu = beispielSatz({ content: 'alt', krypto_id: K });
  for (const herkunft of ['sicherung', 'archiv'] as const) {
    const ergebnis = satzErgaenzen(liegend, neu, herkunft);
    assert.ok(ergebnis, herkunft);
    assert.equal(ergebnis.inhalt, 'bearbeitet');
    assert.equal(ergebnis.bearbeitetAm, '2026-10-11T00:00:00Z');
    assert.deepEqual(ergebnis.reaktionen, [{ emoji: 'x', userId: '9' }]);
    assert.equal(ergebnis.kryptoId, K, 'die fehlende Kennung kommt dazu');
  }
});

test('satzErgaenzen: die Kennung des liegenden Satzes wird nicht überschrieben, verschluesselt bleibt an', () => {
  // Der Archiv-Nachschub kam blind über einen Empfangs-Satz und nahm ihm die
  // kryptoId — mit ihr die Duplikat-Erkennung und den Lesestand-Anker.
  const liegend = beispielSatz({ krypto_id: K, verschluesselt: true });
  assert.equal(satzErgaenzen(liegend, beispielSatz({ verschluesselt: false }), 'sicherung'), null);
  assert.equal(satzErgaenzen(liegend, beispielSatz({ krypto_id: X }), 'archiv'), null);
});

test('satzErgaenzen: aus der eigenen Sicherung kommen fehlende Anhänge dazu, bekannte nicht doppelt', () => {
  const liegend = beispielSatz({ attachments: [{ id: '501' }] });
  const ergebnis = satzErgaenzen(
    liegend,
    beispielSatz({ attachments: [{ id: '501' }, { id: '502' }] }),
    'sicherung'
  );
  assert.ok(ergebnis);
  assert.deepEqual(
    ergebnis.anhaenge.map((a) => (a as { id: string }).id),
    ['501', '502']
  );
});

// Fund 2 der Gegenprüfung (2026-10-12): eine Archiv-Zeile kann jedes
// Kanalmitglied einliefern, und den Autor nennt sie selbst. Der Partner
// liefert eine Zeile mit Kennung und Namen MEINER Nachricht ein, dazu sein
// Bild und einen Antwortbezug — auf meinem Gerät liegt die echte Nachricht
// unter demselben Schlüssel.
test('satzErgaenzen: fremde Anhänge aus dem Archiv landen nicht an der eigenen Nachricht', () => {
  const meine = beispielSatz({ author_id: 'ich', content: 'echt', verschluesselt: true });
  const gefaelscht = beispielSatz({
    author_id: 'ich',
    content: 'gefälscht',
    krypto_id: '42',
    verschluesselt: true,
    reply_to_id: '777',
    attachments: [{ id: '503', verschluesselt: true, schluessel: 'x' }]
  });
  const ergebnis = satzErgaenzen(meine, gefaelscht, 'archiv');
  // Höchstens die Kennung kommt dazu — sie ist hier die eigene ID.
  assert.ok(ergebnis);
  assert.deepEqual(ergebnis, { ...meine, kryptoId: '42' });
  assert.deepEqual(ergebnis.anhaenge, []);
  assert.equal(ergebnis.antwortAufId, null);
  assert.equal(ergebnis.inhalt, 'echt');
  // Kennt der liegende Satz die Kennung schon, gibt es gar nichts zu schreiben.
  assert.equal(satzErgaenzen({ ...meine, kryptoId: '42' }, gefaelscht, 'archiv'), null);
});

test('satzErgaenzen: das Archiv schaltet einen Klartext-Satz nicht auf verschlüsselt', () => {
  // `verschluesselt` entscheidet, welcher Weg Löschen und Bearbeiten nimmt
  // (Server-Route oder Aktions-Umschlag) — eine fremde Zeile stellt ihn nicht um.
  const klartext = beispielSatz({ krypto_id: '42' });
  assert.equal(satzErgaenzen(klartext, beispielSatz({ krypto_id: '42', verschluesselt: true }), 'archiv'), null);
});

test('satzErgaenzen: ein anderer Autor unter demselben Schlüssel überschreibt nichts', () => {
  const fremd = beispielSatz({ author_id: '8', krypto_id: K, content: 'fremd' });
  assert.equal(satzErgaenzen(beispielSatz(), fremd, 'sicherung'), null);
  assert.equal(satzErgaenzen(beispielSatz(), fremd, 'archiv'), null);
});

test('satzErgaenzen: nichts Neues heißt nichts zu schreiben', () => {
  const satz = beispielSatz({ krypto_id: K });
  assert.equal(satzErgaenzen(satz, beispielSatz({ krypto_id: K }), 'sicherung'), null);
  assert.equal(satzErgaenzen(satz, beispielSatz({ krypto_id: K }), 'archiv'), null);
});

// Gegenprüfung 2026-10-12, Fund 5: zwei Sätze desselben Schlüssels in EINEM
// Nachschub liefen beide gegen „liegt nichts", der spätere blind über den
// früheren.
test('nachSchluesselVerdichten: der erste gewinnt, ein späterer ergänzt ihn höchstens', () => {
  const echt = beispielSatz({ content: 'echt' });
  const gefaelscht = beispielSatz({ content: 'gefälscht', krypto_id: '42', attachments: [{ id: '504' }] });
  const anderer = beispielSatz({ id: '43', content: 'andere Nachricht' });
  const aus = nachSchluesselVerdichten([echt, anderer, gefaelscht], 'archiv');
  assert.deepEqual(aus.map((s) => s.nachrichtId), ['42', '43']);
  assert.equal(aus[0].inhalt, 'echt');
  assert.deepEqual(aus[0].anhaenge, []);
  assert.equal(aus[0].kryptoId, '42');
  // Ein fremder Autor unter demselben Schlüssel verdrängt den ersten nicht —
  // und fällt auch nicht weg: beide laufen nacheinander durch die Platzwahl
  // (`platzWahl.ts`, Gegenprüfung 2026-10-12, Fund 3).
  const fremd = beispielSatz({ author_id: '8', content: 'fremd' });
  const beide = nachSchluesselVerdichten([echt, fremd], 'sicherung');
  assert.deepEqual(beide.map((s) => s.inhalt), ['echt', 'fremd']);
});

// Gegenprüfung 2026-10-12, Fund 4: eine Archiv-Bestandszeile ohne
// Einlieferer nennt ihren Autor selbst. Bob gab `{i: K, a: Alice, t: "gefälscht"}`
// als Alices Nachricht aus; über die Erstsicherung wurde sie zu Alices
// eigener Wahrheit. Ihr Satz trägt `ungeprueft` (`verlauf/herkunft.ts`).
test('satzErgaenzen: ein ungeprüfter Satz weicht jedem geprüften desselben Autors, nie umgekehrt', () => {
  const ungeprueft = beispielSatz({
    content: 'gefälscht',
    krypto_id: K,
    archiv_ungeprueft: true,
    attachments: [{ id: '505' }]
  });
  assert.equal(ungeprueft.ungeprueft, true);
  const echt = beispielSatz({ content: 'echt', krypto_id: K });
  for (const herkunft of ['sicherung', 'archiv'] as const) {
    const ersetzt = satzErgaenzen(ungeprueft, echt, herkunft);
    assert.ok(ersetzt, herkunft);
    assert.equal(ersetzt.inhalt, 'echt');
    assert.deepEqual(ersetzt.anhaenge, []);
    assert.equal(ersetzt.ungeprueft, undefined);
  }
  // Umgekehrt ergänzt ein ungeprüfter höchstens die Kennung.
  assert.equal(satzErgaenzen(echt, ungeprueft, 'archiv'), null);
  // Ein Grabstein bleibt einer, auch gegen einen geprüften Nachschub.
  assert.equal(satzErgaenzen({ ...ungeprueft, geloescht: true }, echt, 'sicherung'), null);
});
