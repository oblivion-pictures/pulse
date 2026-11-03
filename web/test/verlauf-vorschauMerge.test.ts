import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  juengsterSichtbarerSatz,
  mitLokalerVorschauMergen,
  vorschauAusSatzOderLeer,
  vorschauAusText,
  type LokalerLetzterSatz,
  type ServerDmVorschau
} from '../src/lib/verlauf/vorschauMerge.ts';

function lokal(overrides: Partial<LokalerLetzterSatz> = {}): LokalerLetzterSatz {
  return {
    nachrichtId: '1700000000000123456', // lokale ID (19-stellig, s. lokaleNachrichtId())
    autorId: 'u1',
    erstelltAm: '2026-08-28T10:00:00Z',
    inhalt: 'hallo',
    anhaenge: [],
    ...overrides
  };
}

test('C3: eine verschluesselte Nachricht ohne Server-Vorschau bleibt heute veraltet/leer — die Gegenprobe', () => {
  // Befund vor dem Fix: der Server kennt die verschluesselte Nachricht nie,
  // `last_message_id` bleibt `null` (kein Klartext je gesendet). Ohne Merge
  // zeigt die Liste GAR KEINE Vorschau, obwohl lokal eine Nachricht vorliegt.
  const server: ServerDmVorschau = { last_message_id: null, last_message_preview: null };
  assert.equal(server.last_message_preview, null); // <- das waere die rote Anzeige ohne Fix
  const gemergt = mitLokalerVorschauMergen(server, lokal());
  assert.equal(gemergt.last_message_preview, 'hallo');
  assert.equal(gemergt.last_message_id, '1700000000000123456');
});

test('C4: ein STALE Server last_message_id (aeltere Klartext-Nachricht) wird durch die neuere lokale Kennung ersetzt', () => {
  // Snowflake 5000ms nach Epoch — s. verlauf-zusammenfuegen.test.ts, deutlich
  // AELTER als die lokale ID unten (Date.now()=1700000000000 -> 2023-11-14,
  // aber embedded-time-Vergleich zaehlt die absolute Millisekunde: die
  // Snowflake liegt 2026, die lokale ID 2023 — hier drehen wir den Fall um,
  // damit die lokale ID GARANTIERT NEUER ist).
  const jetzt = Date.now().toString().padStart(13, '0') + '0000001';
  const server: ServerDmVorschau = {
    last_message_id: '20971520000', // Snowflake, 5s nach Epoch (2026-01-01)
    last_message_preview: 'alte klartext-nachricht',
    last_message_author_id: 'u2',
    last_message_at: '2026-01-01T00:00:05Z'
  };
  const ergebnis = mitLokalerVorschauMergen(server, lokal({ nachrichtId: jetzt, inhalt: 'neu' }));
  assert.equal(ergebnis.last_message_id, jetzt);
  assert.equal(ergebnis.last_message_preview, 'neu');
  assert.equal(ergebnis.last_message_author_id, 'u1');
});

test('der Server-Wert bleibt unangetastet, wenn er gleich neu oder neuer ist (Weg fuer unverschluesselte Gespraeche)', () => {
  const server: ServerDmVorschau = {
    last_message_id: '20971520000',
    last_message_preview: 'server text',
    last_message_author_id: 'u2',
    last_message_at: '2026-01-01T00:00:05Z'
  };
  // Lokale ID AELTER als die Server-Snowflake (2023 vs. 2026-01-01+5s).
  const ergebnis = mitLokalerVorschauMergen(server, lokal({ nachrichtId: '1700000000000123456' }));
  assert.deepEqual(ergebnis, server);
});

test('kein lokaler Satz -> Server-Wert unveraendert', () => {
  const server: ServerDmVorschau = { last_message_id: null };
  assert.deepEqual(mitLokalerVorschauMergen(server, null), server);
});

test('vorschauAusText: Zeilenumbrueche werden zu Leerzeichen und auf 80 Zeichen gekuerzt', () => {
  const lang = 'x'.repeat(100);
  assert.equal(vorschauAusText('a\r\nb\nc', null), 'a b c');
  assert.equal(vorschauAusText(lang, null)?.length, 80);
});

test('vorschauAusText: leerer Text mit Bild-Anhang -> __image__, mit anderem Anhang -> __file__', () => {
  assert.equal(vorschauAusText('', 'image/png'), '__image__');
  assert.equal(vorschauAusText('   ', 'application/pdf'), '__file__');
  assert.equal(vorschauAusText('', null), null);
});

// Fund 6 (Bughunt 2026-11-02): Löschen der letzten Nachricht ließ ihren Text
// in der DM-Liste stehen; beim nächsten Start fiel die Vorschau auf den
// Server-Wert zurück, weil der jüngste Satz ein Grabstein war.
test('Fund 6: der jüngste sichtbare Satz überspringt Grabsteine und die gerade gelöschte ID', () => {
  const saetze = [
    { ...lokal({ nachrichtId: 'a', inhalt: 'eins' }), geloescht: false },
    { ...lokal({ nachrichtId: 'b', inhalt: 'zwei' }), geloescht: true },
    { ...lokal({ nachrichtId: 'c', inhalt: 'drei' }), geloescht: false }
  ];
  assert.equal(juengsterSichtbarerSatz(saetze)?.nachrichtId, 'c');
  // Grabstein von „c“ noch nicht geschrieben: `ausser` nimmt sie trotzdem aus,
  // und „b“ ist schon ein Grabstein → „a“.
  assert.equal(juengsterSichtbarerSatz(saetze, 'c')?.nachrichtId, 'a');
  assert.equal(juengsterSichtbarerSatz([saetze[1]]), null);
  assert.equal(juengsterSichtbarerSatz([]), null);
});

test('Fund 6: nach dem Löschen rückt die Vorschau auf den Nachfolger oder wird leer', () => {
  const dm: ServerDmVorschau = {
    last_message_id: 'c',
    last_message_preview: 'geheim',
    last_message_author_id: 'u2',
    last_message_at: '2026-11-02T10:00:00Z'
  };
  const nachfolger = vorschauAusSatzOderLeer(dm, lokal({ nachrichtId: 'a', inhalt: 'eins' }));
  assert.equal(nachfolger.last_message_id, 'a');
  assert.equal(nachfolger.last_message_preview, 'eins');
  assert.equal(nachfolger.last_message_author_id, 'u1');

  const leer = vorschauAusSatzOderLeer(dm, null);
  assert.equal(leer.last_message_preview, null);
  assert.equal(leer.last_message_author_id, null);
  // Die Zeile springt nicht ans Ende: die Sortier-ID bleibt.
  assert.equal(leer.last_message_id, 'c');
});
