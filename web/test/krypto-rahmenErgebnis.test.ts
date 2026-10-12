import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baueLoeschNutzlast,
  baueReaktionsNutzlast,
  baueBearbeitungsNutzlast,
  leseNachrichtNutzlast,
  rahmenAusNutzlast
} from '../src/lib/krypto/nachrichtNutzlast.ts';

/**
 * Die Frame-Erkennung (`rahmenAusNutzlast`) ist die GEMEINSAME
 * Fallunterscheidung beider Empfangswege — Olm (DMs) und Megolm (private
 * Gruppen, `gruppe/empfangen.ts`). Erkennt sie einen Frame auf dem einen Weg
 * anders als auf dem anderen, sieht die Gegenseite eine Reaktion als leere
 * Nachricht (oder umgekehrt). Der Absender steht bewusst NICHT in der
 * Nutzlast — er wird je Weg ermittelt und nur durchgereicht.
 */

const AUTOR = 'autor-1';
const KANAL = 'kanal-42';
const ZUSTELLUNG = 'zustell-77';
/** Die Kennung der Ziel-Nachricht — eine Ziffernfolge wie jede echte ID. */
const ZIEL = '1760000000000000009';

test('Loesch-, Reaktions- und Bearbeitungs-Frames werden erkannt', () => {
  const loeschung = rahmenAusNutzlast(
    leseNachrichtNutzlast(baueLoeschNutzlast(ZIEL)),
    ZUSTELLUNG,
    KANAL,
    AUTOR
  );
  assert.deepEqual(loeschung, {
    art: 'loeschung',
    id: ZUSTELLUNG,
    channelId: KANAL,
    nachrichtId: ZIEL,
    absenderUserId: AUTOR
  });

  const reaktion = rahmenAusNutzlast(
    leseNachrichtNutzlast(baueReaktionsNutzlast(ZIEL, '👍', false)),
    ZUSTELLUNG,
    KANAL,
    AUTOR
  );
  assert.deepEqual(reaktion, {
    art: 'reaktion',
    id: ZUSTELLUNG,
    channelId: KANAL,
    autorId: AUTOR,
    ziel: ZIEL,
    emoji: '👍',
    entfernen: false
  });

  const reaktionZurueck = rahmenAusNutzlast(
    leseNachrichtNutzlast(baueReaktionsNutzlast(ZIEL, '👍', true)),
    ZUSTELLUNG,
    KANAL,
    AUTOR
  );
  assert.equal(reaktionZurueck?.art, 'reaktion');
  assert.equal(reaktionZurueck.entfernen, true);

  const bearbeitung = rahmenAusNutzlast(
    leseNachrichtNutzlast(baueBearbeitungsNutzlast(ZIEL, 'Neuer Text')),
    ZUSTELLUNG,
    KANAL,
    AUTOR
  );
  // Der Absender reist mit: nur seine eigenen Sätze darf er umschreiben.
  assert.deepEqual(bearbeitung, {
    art: 'bearbeitung',
    id: ZUSTELLUNG,
    channelId: KANAL,
    autorId: AUTOR,
    ziel: ZIEL,
    inhalt: 'Neuer Text'
  });
});

test('Kein Frame: gewoehnliche Nachricht und Loesch-Frame ohne ID fallen durch', () => {
  // Gewoehnliche Nachricht (mit Text und ID) — keine der Frame-Marken gesetzt.
  const nachricht = leseNachrichtNutzlast(
    new TextEncoder().encode(JSON.stringify({ v: 1, text: 'Hallo', id: ZIEL }))
  );
  assert.equal(rahmenAusNutzlast(nachricht, ZUSTELLUNG, KANAL, AUTOR), null);

  // Fail-closed: `geloescht` ohne ID ist kein Loesch-Frame — er faellt als
  // (leere) Nachricht durch, statt den Grabstein auf eine unbekannte ID zu
  // setzen (dieselbe Regel wie im Olm-Weg vor der Zusammenfassung).
  const kaputt = leseNachrichtNutzlast(
    new TextEncoder().encode(JSON.stringify({ v: 1, text: '', geloescht: true }))
  );
  assert.equal(rahmenAusNutzlast(kaputt, ZUSTELLUNG, KANAL, AUTOR), null);
});

// Gegenprüfung 2026-10-12, Fund 1: jede Kennung der Nutzlast wählt der
// Absender frei. Ein Lösch-Frame mit `id: "x"` landete bis dahin im
// Grabstein-Register und als Stein in der Sicherung, an dem jede
// Wiederherstellung des Kanals scheiterte.
test('Fund 1: ein Aktions-Frame mit ungültigem Ziel wird verworfen, nicht angezeigt', () => {
  const roh = (objekt: Record<string, unknown>) =>
    leseNachrichtNutzlast(new TextEncoder().encode(JSON.stringify({ v: 1, text: '', ...objekt })));
  for (const frame of [
    { geloescht: true, id: 'x' },
    { geloescht: true, id: '0123' },
    { geloescht: true, id: '1'.repeat(21) },
    { reaktion: { ziel: 'x', emoji: '👍' } },
    { bearbeitung: { ziel: '12a', inhalt: 'neu' } }
  ]) {
    const gelesen = roh(frame);
    assert.equal(gelesen.verworfen, true, JSON.stringify(frame));
    assert.deepEqual(
      rahmenAusNutzlast(gelesen, ZUSTELLUNG, KANAL, AUTOR),
      { art: 'ohneAblage', id: ZUSTELLUNG },
      JSON.stringify(frame)
    );
  }
  // Gegenprobe: mit gültigem Ziel bleibt es ein Lösch-Frame.
  assert.equal(rahmenAusNutzlast(roh({ geloescht: true, id: ZIEL }), ZUSTELLUNG, KANAL, AUTOR)?.art, 'loeschung');
});

test('Fund 1: eine gewöhnliche Nachricht verliert nur ihre ungültigen Kennungen', () => {
  const gelesen = leseNachrichtNutzlast(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        text: 'hallo',
        id: 'x',
        replyToId: '../y',
        anhaenge: [
          { id: '../datei', name: 'a', typ: 'image/png', groesse: 1, schluessel: 's' },
          { id: '7', name: 'b', typ: 'image/png', groesse: 1, schluessel: 's' }
        ]
      })
    )
  );
  assert.equal(gelesen.text, 'hallo');
  assert.equal(gelesen.id, null);
  assert.equal(gelesen.replyToId, null);
  // Aus der Anhang-ID wird ein Dateiname im Laufwerk — `../datei` fällt heraus.
  assert.deepEqual(
    gelesen.anhaenge.map((a) => a.id),
    ['7']
  );
  assert.equal(gelesen.verworfen, undefined);
  assert.equal(rahmenAusNutzlast(gelesen, ZUSTELLUNG, KANAL, AUTOR), null);
});
