/**
 * Die geräteübergreifende Identität einer verschlüsselten Nachricht
 * (`verlauf/nachrichtIdentitaet.ts`) — und die Wurzel, an der sie fehlte:
 * die Kopie des Absenders trug bis zum 2026-10-13 keine `krypto_id`.
 *
 * Fehlerbild: spiegeln zwei eigene Geräte in dieselbe Sicherung (das
 * Sendegerät seine Kopie unter der eigenen Id A, das Zweitgerät die
 * Selbstzustellung unter der Zustellungs-Id Z mit `krypto_id` A), bekam ein
 * Frischgerät beim Wiederherstellen beide Zeilen — jeder Abgleich verglich
 * nur `kryptoId` mit `kryptoId`, nie mit der `id` einer anderen Zeile.
 *
 * Werte im Format der echten Ids: lokale Autor-Id 19 Ziffern
 * (`lokaleNachrichtId`), Zustellungs-Ids Server-Snowflakes mit 18 Ziffern.
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  kanonischeNachrichtId,
  istBekannteNachricht
} from '../src/lib/verlauf/nachrichtIdentitaet.ts';

const AUTOR_ID = '1791841626624331125'; // vom Absender gewählt
const ZUSTELLUNG_ZWEITGERAET = '103281734567890123';
const ZUSTELLUNG_EMPFAENGER = '103281734567890124';

test('kanonische Id: die mitgereiste kryptoId, ohne sie die eigene id', () => {
  assert.equal(kanonischeNachrichtId(ZUSTELLUNG_ZWEITGERAET, AUTOR_ID), AUTOR_ID);
  assert.equal(kanonischeNachrichtId(AUTOR_ID, AUTOR_ID), AUTOR_ID);
  assert.equal(kanonischeNachrichtId(AUTOR_ID, null), AUTOR_ID);
  assert.equal(kanonischeNachrichtId(AUTOR_ID, undefined), AUTOR_ID);
});

describe('istBekannteNachricht (Prüfung des Nachrichten-Stores)', () => {
  it('Empfangs-Kopie trifft die Absender-Kopie aus dem Altbestand (nur unter den ids bekannt)', () => {
    assert.equal(
      istBekannteNachricht(ZUSTELLUNG_ZWEITGERAET, AUTOR_ID, new Set([AUTOR_ID]), new Set()),
      true
    );
  });

  it('Absender-Kopie aus dem Altbestand trifft eine liegende Empfangs-Kopie (unter den kryptoIds)', () => {
    assert.equal(
      istBekannteNachricht(
        AUTOR_ID,
        undefined,
        new Set([ZUSTELLUNG_ZWEITGERAET]),
        new Set([AUTOR_ID])
      ),
      true
    );
  });

  it('neue Absender-Kopie (kryptoId = id) trifft eine liegende Empfangs-Kopie', () => {
    assert.equal(
      istBekannteNachricht(
        AUTOR_ID,
        AUTOR_ID,
        new Set([ZUSTELLUNG_ZWEITGERAET]),
        new Set([AUTOR_ID])
      ),
      true
    );
  });

  it('gleiche id bleibt bekannt, eine fremde Nachricht nicht', () => {
    assert.equal(istBekannteNachricht('5', undefined, new Set(['5']), new Set()), true);
    assert.equal(
      istBekannteNachricht('6', undefined, new Set(['5']), new Set([AUTOR_ID])),
      false,
      'Klartext ohne kryptoId mit anderer id ist eine andere Nachricht'
    );
    assert.equal(
      istBekannteNachricht(ZUSTELLUNG_EMPFAENGER, '1791841626624331126', new Set([AUTOR_ID]), new Set()),
      false,
      'andere Autor-Id, andere Nachricht'
    );
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
