import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  frameZiele,
  lokaleIdsFuerLoeschung,
  trifftFrame,
  type FrameKandidat
} from '../src/lib/krypto/loeschZiel.ts';

const ICH = 'konto-ich';
const PARTNER = 'konto-partner';

// Der Fall vom 2026-09-02: die Gegenseite hält die Nachricht unter der
// Zustellungs-ID und kennt die Absender-ID nur als krypto_id.
test('empfangene Nachricht wird ueber krypto_id gefunden, nicht ueber die Frame-ID', () => {
  const lokal = [
    { id: 'zustellung-77', krypto_id: 'absender-1', author_id: PARTNER },
    { id: 'zustellung-78', krypto_id: 'absender-2', author_id: PARTNER }
  ];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal, PARTNER), ['zustellung-77']);
});

test('eigener Satz des Absenders traegt die Frame-ID direkt', () => {
  const lokal = [
    { id: 'absender-1', author_id: PARTNER },
    { id: 'absender-2', author_id: PARTNER }
  ];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal, PARTNER), ['absender-1']);
});

test('eigener Satz seit 2026-10-13 (krypto_id = id) wird genau einmal getroffen', () => {
  const lokal = [{ id: 'absender-1', krypto_id: 'absender-1', author_id: PARTNER }];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal, PARTNER), ['absender-1']);
});

test('beide Formen zugleich liefern jede lokale ID genau einmal', () => {
  const lokal = [
    { id: 'absender-1', author_id: PARTNER },
    { id: 'zustellung-77', krypto_id: 'absender-1', author_id: PARTNER },
    { id: 'zustellung-77', krypto_id: 'absender-1', author_id: PARTNER }
  ];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', lokal, PARTNER), [
    'absender-1',
    'zustellung-77'
  ]);
});

test('ohne Treffer bleibt die Liste leer — der Aufrufer entscheidet dann', () => {
  assert.deepEqual(
    lokaleIdsFuerLoeschung('absender-9', [{ id: 'x', krypto_id: 'y', author_id: PARTNER }], PARTNER),
    []
  );
});

// Der eigentliche Riegel: ein Lösch-Frame trägt eine ID und sonst nichts.
// Der Gesprächspartner kennt die ID jeder Nachricht, die ich ihm geschickt
// habe — bei mir ist sie die lokale `id`. Ohne Autorvergleich löschte sein
// angepasster Klient meine eigenen Nachrichten auf meinem Gerät.
test('der Partner kann meine eigene Nachricht nicht loeschen', () => {
  const meineNachricht = [{ id: 'meine-1', author_id: ICH }];
  assert.deepEqual(lokaleIdsFuerLoeschung('meine-1', meineNachricht, PARTNER), []);
});

test('ich selbst loesche meine eigene Nachricht weiterhin', () => {
  const meineNachricht = [{ id: 'meine-1', author_id: ICH }];
  assert.deepEqual(lokaleIdsFuerLoeschung('meine-1', meineNachricht, ICH), ['meine-1']);
});

test('ein Satz ohne bekannten Autor wird nicht geloescht', () => {
  const ohneAutor = [{ id: 'zustellung-77', krypto_id: 'absender-1' }];
  assert.deepEqual(lokaleIdsFuerLoeschung('absender-1', ohneAutor, PARTNER), []);
});

// ── Der Rückfall auf die Frame-ID (Befund N1, 2026-10-11) ───────────────────
// `empfangen.ts` löschte bei leerer Trefferliste die Frame-ID selbst. Beim
// Verfasser liegt seine eigene Nachricht genau unter dieser ID — der Partner
// kennt sie, baut einen Lösch-Frame darauf, die Autor-Bindung weist ihn ab,
// und der Rückfall löschte trotzdem, samt Grabstein in der Sicherung.

/** Ein Verlauf zum Nachschlagen, der dieselbe Regel anwendet wie
 *  `verlauf/db.ts::verlaufSatzIdsFuerFrame` — ohne IndexedDB. Die echte
 *  Funktion gegen die echte Datenbank prüft
 *  `tests/e2e/verlauf-register.spec.ts` (Gegenprüfung 2026-10-12, Fund 9). */
function verlaufMit(saetze: FrameKandidat[]) {
  return (frameId: string, absender?: string) => async () =>
    saetze.filter((s) => trifftFrame(frameId, s, absender)).map((s) => s.id);
}

test('N1: ein fremder Lösch-Frame auf meine eigene Nachricht löscht nichts — weder geladen noch im Verlauf', async () => {
  // Meine Nachricht liegt bei mir unter der ID, die der Partner mit ihr bekam.
  const geladen = [{ id: 'meine-1', author_id: ICH }];
  const imVerlauf = verlaufMit([{ id: 'meine-1', kryptoId: null, autorId: ICH }]);
  assert.deepEqual(await frameZiele('meine-1', geladen, imVerlauf('meine-1', PARTNER), PARTNER), []);
  // Auch wenn sie gerade nicht geladen ist — der Verlauf bindet genauso.
  assert.deepEqual(await frameZiele('meine-1', [], imVerlauf('meine-1', PARTNER), PARTNER), []);
});

test('N1: ohne jeden Treffer bleibt das Ergebnis leer, statt auf die Frame-ID zurückzufallen', async () => {
  assert.deepEqual(await frameZiele('unbekannt-9', [], verlaufMit([])('unbekannt-9', PARTNER), PARTNER), []);
});

test('N1: die echte Löschung des Verfassers wirkt weiter — beim Empfänger über krypto_id', async () => {
  const imVerlauf = verlaufMit([
    { id: 'zustellung-77', kryptoId: 'absender-1', autorId: PARTNER },
    { id: 'zustellung-78', kryptoId: 'absender-2', autorId: PARTNER }
  ]);
  assert.deepEqual(
    await frameZiele('absender-1', [], imVerlauf('absender-1', PARTNER), PARTNER),
    ['zustellung-77']
  );
});

test('N1: auf dem Zweitgerät des Verfassers trifft der Frame den Satz unter seiner eigenen ID, auch ungeladen', async () => {
  // Diesen Fall deckte vorher allein der Rückfall: der Verlaufs-Nachschlag
  // suchte nur über `kryptoId`, und eine aus der Sicherung zurückgeholte
  // eigene Nachricht trägt keine.
  const imVerlauf = verlaufMit([{ id: 'meine-1', kryptoId: null, autorId: ICH }]);
  assert.deepEqual(await frameZiele('meine-1', [], imVerlauf('meine-1', ICH), ICH), ['meine-1']);
});

test('N1: geladene Anzeige und Verlauf zusammen — jede lokale Kopie genau einmal', async () => {
  const geladen = [{ id: 'zustellung-77', krypto_id: 'absender-1', author_id: PARTNER }];
  const imVerlauf = verlaufMit([
    { id: 'zustellung-77', kryptoId: 'absender-1', autorId: PARTNER },
    { id: 'absender-1', kryptoId: 'absender-1', autorId: PARTNER }
  ]);
  assert.deepEqual(
    await frameZiele('absender-1', geladen, imVerlauf('absender-1', PARTNER), PARTNER),
    ['zustellung-77', 'absender-1']
  );
});

test('trifftFrame: Autor-Bindung greift auf beiden Formen, ohne Bindung nur die ID', () => {
  const eigen: FrameKandidat = { id: 'meine-1', kryptoId: null, autorId: ICH };
  const empfangen: FrameKandidat = { id: 'z-1', kryptoId: 'meine-1', autorId: ICH };
  assert.equal(trifftFrame('meine-1', eigen, PARTNER), false);
  assert.equal(trifftFrame('meine-1', empfangen, PARTNER), false);
  assert.equal(trifftFrame('meine-1', eigen, ICH), true);
  assert.equal(trifftFrame('meine-1', empfangen, ICH), true);
  // Reaktionen suchen ungebunden — sie löschen nichts.
  assert.equal(trifftFrame('meine-1', eigen), true);
  assert.equal(trifftFrame('andere', eigen), false);
  // Ohne bekannten Autor trifft ein gebundener Frame nie.
  assert.equal(trifftFrame('meine-1', { id: 'meine-1' }, ICH), false);
});

test('Bearbeitung mit Absender-Bindung: der Partner schreibt meine eigene Nachricht nicht um', async () => {
  // Derselbe Weg wie beim Lösch-Frame (`empfangen.ts` reicht beim
  // Bearbeitungs-Frame seit 2026-10-12 den Absender mit). Geprüft wird hier
  // nur die Zielauflösung; dass der Empfangsweg den Absender tatsächlich
  // übergibt, prüft `krypto-zyklusAuswerten.test.ts` (seit der Ablauf in
  // `zyklusAuswerten.ts` steht, lädt er unter Nodes Läufer).
  const geladen = [{ id: 'meine-1', author_id: ICH }];
  const imVerlauf = verlaufMit([{ id: 'meine-1', kryptoId: null, autorId: ICH }]);
  assert.deepEqual(await frameZiele('meine-1', geladen, imVerlauf('meine-1', PARTNER), PARTNER), []);
  assert.deepEqual(await frameZiele('meine-1', geladen, imVerlauf('meine-1', ICH), ICH), ['meine-1']);
});
