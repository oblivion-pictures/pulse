/**
 * Fenster-Ströme: wann ein HQ-Stream seine Kachel ans eigene Player-Fenster
 * abgibt, welche Fenster das Abzeichen „Fenster“ nach vorne holt, und wann die
 * Chat-Seitenleiste im Sprachkanal steht.
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`. Das Modul
 * unter Prüfung importiert bewusst nichts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  laeuftImFenster,
  offeneFenster,
  seitenleistenStreamer
} from '../src/lib/player/imFenster.ts';

const whep = (phase: string) => ({ phase, direkt: false });
const direkt = (phase: string) => ({ phase, direkt: true });

describe('laeuftImFenster', () => {
  it('erst ab playing — beim Hochkommen hält die Kachel noch die Verbindung', () => {
    assert.equal(laeuftImFenster(whep('connecting')), false);
    assert.equal(laeuftImFenster(whep('playing')), true);
  });

  it('ein gescheitertes oder geschlossenes Fenster gibt die Kachel zurück', () => {
    assert.equal(laeuftImFenster(whep('failed')), false);
    assert.equal(laeuftImFenster(whep('closed')), false);
  });

  it('ohne Sitzung keine Fenster-Lage', () => {
    assert.equal(laeuftImFenster(null), false);
    assert.equal(laeuftImFenster(undefined), false);
  });

  it('ein Direktfenster ersetzt keine Kachel', () => {
    assert.equal(laeuftImFenster(direkt('playing')), false);
  });
});

describe('offeneFenster', () => {
  it('nimmt jedes spielende Fenster, Direktfenster eingeschlossen', () => {
    const a = whep('playing');
    const b = direkt('playing');
    assert.deepEqual(offeneFenster([a, whep('connecting'), b, whep('closed')]), [a, b]);
  });

  it('leer, wenn keins spielt', () => {
    assert.deepEqual(offeneFenster([whep('connecting'), whep('failed')]), []);
  });
});

describe('seitenleistenStreamer', () => {
  const wunsch = { channelId: 'k1', userId: 'u1' };

  it('zeigt den Streamer im passenden Kanal, solange ein Fenster läuft', () => {
    assert.equal(seitenleistenStreamer(wunsch, 'k1', [whep('playing')]), 'u1');
  });

  it('nichts in einem anderen Kanal', () => {
    assert.equal(seitenleistenStreamer(wunsch, 'k2', [whep('playing')]), null);
  });

  it('nichts, sobald das letzte Fenster zu ist — dann hat die Kachel den Chat', () => {
    assert.equal(seitenleistenStreamer(wunsch, 'k1', [whep('closed')]), null);
    assert.equal(seitenleistenStreamer(wunsch, 'k1', []), null);
  });

  it('nichts ohne Wunsch', () => {
    assert.equal(seitenleistenStreamer(null, 'k1', [whep('playing')]), null);
  });
});
