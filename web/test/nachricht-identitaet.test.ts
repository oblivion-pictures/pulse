/**
 * Die geräteübergreifende Identität einer verschlüsselten Nachricht im
 * Nachrichten-Store (`nachrichten/listenKern.ts`, Regel in
 * `verlauf/identitaet.ts`) — und die Wurzel, an der sie fehlte: die Kopie
 * des Absenders trug bis zum 2026-10-13 keine `krypto_id`.
 *
 * Fehlerbild: spiegeln zwei eigene Geräte in dieselbe Sicherung (das
 * Sendegerät seine Kopie unter der eigenen Id A, das Zweitgerät die
 * Selbstzustellung unter der Zustellungs-Id Z mit `krypto_id` A), bekam ein
 * Frischgerät beim Wiederherstellen beide Zeilen — jeder Abgleich verglich
 * nur `kryptoId` mit `kryptoId`, nie mit der `id` einer anderen Zeile.
 *
 * Die Fälle liefen bis zum 2026-10-13 gegen eine Prüfung aus Kennung allein
 * (c5a25317); sie gehen jetzt durch die Rechnung des Stores selbst, und
 * jeder nennt den Autor. Der Fälschungsfall unten ist der Grund: die Kennung
 * wählt der Absender frei.
 *
 * Werte im Format der echten Ids: lokale Autor-Id 19 Ziffern
 * (`lokaleNachrichtId`), Zustellungs-Ids Server-Snowflakes mit 18 Ziffern.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { einfuegen, identitaetenVon, vorneAnfuegen } from '../src/lib/nachrichten/listenKern.ts';
import type { Message } from '../src/lib/api/types.ts';

const AUTOR_ID = '1791841626624331125'; // vom Absender gewählt
const ZUSTELLUNG_ZWEITGERAET = '103281734567890123';
const ZUSTELLUNG_EMPFAENGER = '103281734567890124';
const ALICE = '103247050000000001';
const BOB = '103247050000000002';

function nachricht(id: string, autor: string, kryptoId?: string): Message {
  return {
    id,
    channel_id: 'k1',
    author_id: autor,
    content: `von ${autor}`,
    nonce: null,
    created_at: '2026-10-13T09:00:00Z',
    ...(kryptoId ? { krypto_id: kryptoId } : {})
  };
}

/** Hält der Store `liegend`, ist `neu` dann eine Dublette? */
function istDublette(liegend: Message[], neu: Message): boolean {
  const ids = new Set(liegend.map((m) => m.id));
  return einfuegen(liegend, ids, identitaetenVon(liegend), neu, 100, new Set()) === null;
}

describe('Nachrichten-Store: Kopien derselben Nachricht', () => {
  it('Empfangs-Kopie trifft die Absender-Kopie aus dem Altbestand', () => {
    assert.equal(
      istDublette([nachricht(AUTOR_ID, ALICE)], nachricht(ZUSTELLUNG_ZWEITGERAET, ALICE, AUTOR_ID)),
      true
    );
  });

  it('Absender-Kopie aus dem Altbestand trifft eine liegende Empfangs-Kopie', () => {
    assert.equal(
      istDublette([nachricht(ZUSTELLUNG_ZWEITGERAET, ALICE, AUTOR_ID)], nachricht(AUTOR_ID, ALICE)),
      true
    );
  });

  it('neue Absender-Kopie (krypto_id = id) trifft eine liegende Empfangs-Kopie', () => {
    assert.equal(
      istDublette(
        [nachricht(ZUSTELLUNG_ZWEITGERAET, ALICE, AUTOR_ID)],
        nachricht(AUTOR_ID, ALICE, AUTOR_ID)
      ),
      true
    );
  });

  it('gleiche id bleibt bekannt, eine fremde Nachricht nicht', () => {
    assert.equal(istDublette([nachricht('5', ALICE)], nachricht('5', ALICE)), true);
    assert.equal(
      istDublette(
        [nachricht('5', ALICE), nachricht(ZUSTELLUNG_ZWEITGERAET, ALICE, AUTOR_ID)],
        nachricht('6', ALICE)
      ),
      false,
      'Klartext ohne krypto_id mit anderer id ist eine andere Nachricht'
    );
    assert.equal(
      istDublette(
        [nachricht(AUTOR_ID, ALICE)],
        nachricht(ZUSTELLUNG_EMPFAENGER, ALICE, '1791841626624331126')
      ),
      false,
      'andere Autor-Id, andere Nachricht'
    );
  });

  it('Fälschung: Bobs Kopie mit Alices Kennung bleibt neben Alices sichtbar', () => {
    const alices = [nachricht(AUTOR_ID, ALICE), nachricht(AUTOR_ID, ALICE, AUTOR_ID)];
    const bobs = nachricht(ZUSTELLUNG_EMPFAENGER, BOB, AUTOR_ID);
    for (const alice of alices) {
      // In beiden Reihenfolgen und auch beim Hochscrollen.
      assert.equal(istDublette([alice], bobs), false, 'Bob nach Alice');
      assert.equal(istDublette([bobs], alice), false, 'Alice nach Bob');
      const liegend = [nachricht('120000000000000099', ALICE)];
      const seite = vorneAnfuegen(
        liegend,
        new Set(liegend.map((m) => m.id)),
        identitaetenVon(liegend),
        [alice, bobs],
        100,
        new Set()
      );
      assert.ok(seite);
      assert.deepEqual(seite.neu.map((m) => m.author_id).sort(), [ALICE, BOB].sort());
    }
  });
});

/* ————————————————————————————————————————————————————————————————
 * Quelltext-Gegenproben für die Wurzel — die Sendewege laufen nicht im
 * Node-Läufer (Svelte-Stores, IndexedDB; s. CLAUDE.md „Die Falle"), dasselbe
 * Muster wie `sicherung-anschluss.test.ts`. Jede schlägt auf dem Stand vor
 * dem 2026-10-13 fehl.
 * ———————————————————————————————————————————————————————————————— */

const HIER = dirname(fileURLToPath(import.meta.url));
const lese = (rel: string) => readFileSync(join(HIER, '..', rel), 'utf8');

/** Der Rumpf des `Message`-Objekts, das ein Sendeweg mit `id: nachrichtId`
 *  baut — von dort bis zu seinem abschließenden `};`. */
function eigeneNachricht(quelle: string): string {
  const anfang = quelle.indexOf('id: nachrichtId,');
  assert.ok(anfang >= 0, 'der Sendeweg baut seine Nachricht unter `id: nachrichtId`');
  return quelle.slice(anfang, quelle.indexOf('};', anfang));
}

describe('die Kopie des Absenders trägt ihre Identität von Anfang an', () => {
  for (const pfad of [
    'src/lib/krypto/senden.ts',
    'src/lib/krypto/gruppe/senden.ts',
    'src/lib/krypto/gruppe/kanalSenden.ts'
  ]) {
    it(`${pfad}: krypto_id = nachrichtId`, () => {
      assert.match(eigeneNachricht(lese(pfad)), /krypto_id: nachrichtId\b/);
    });
  }

  it('der Laufwerk-Leser des Ablage-Kanals reicht die kryptoId durch', () => {
    assert.match(
      lese('src/lib/components/chat/ablageKanalVerlauf.ts'),
      /n\.kryptoId \? \{ krypto_id: n\.kryptoId \} : \{\}/
    );
  });
});
