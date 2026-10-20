import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alsAnrufAktion, alsKlingelnderAnruf } from '../src/lib/anrufe/ausstehendeAktion.ts';
import {
  HINTERGRUND_TAKT_MS,
  hintergrundZyklusStarten,
  hintergrundZyklusStoppen
} from '../src/lib/krypto/hintergrundTakt.ts';
import { meldungGehoertZu } from '../src/lib/platform/meldungZuordnung.ts';
import { nurBehalten } from '../src/lib/stores/lesestandKern.ts';

/**
 * Die reinen Kerne aus dem Push-Bughunt vom 2026-10-20 — je einer pro Befund,
 * der eine Rechnung hat. Die Verdrahtung prüft `push-bughunt-verdrahtung`.
 */

// ── Befund 1: der Hintergrund-Takt ruft die Runde, die man ihm gibt ──────────

test('Hintergrund-Takt: sofort eine Runde, dann je Takt; doppelter Start wirkt nicht', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let runden = 0;
  const runde = () => {
    runden += 1;
  };
  hintergrundZyklusStarten(runde);
  hintergrundZyklusStarten(runde);
  assert.equal(runden, 1, 'die Extra-Runde beim Hintergrund-Werden, nur einmal');
  t.mock.timers.tick(HINTERGRUND_TAKT_MS);
  assert.equal(runden, 2);
  hintergrundZyklusStoppen();
  t.mock.timers.tick(HINTERGRUND_TAKT_MS * 3);
  assert.equal(runden, 2, 'gestoppt läuft nichts mehr');
});

// ── Befund 3: welche zugestellte Meldung gehört zu welcher Unterhaltung ──────

test('Zugestellte Meldung: Android über den tag, iOS über data.channel_id', () => {
  const kanaele = new Set(['42']);
  assert.equal(meldungGehoertZu({ tag: '42' }, kanaele), true);
  assert.equal(meldungGehoertZu({ data: { channel_id: '42' } }, kanaele), true);
  assert.equal(meldungGehoertZu({ data: { channel_id: 42 } }, kanaele), true);
  assert.equal(meldungGehoertZu({ tag: '43', data: { channel_id: '43' } }, kanaele), false);
  assert.equal(meldungGehoertZu({}, kanaele), false);
  assert.equal(meldungGehoertZu({ data: 'unsinn' }, kanaele), false);
});

// ── Befund 8: die aufbewahrte Entscheidung der Android-Hülle ────────────────

test('Ausstehende Aktion: camelCase der Hülle wird zur Form des aktion-Ereignisses', () => {
  assert.deepEqual(
    alsAnrufAktion({
      aktion: 'annehmen',
      callId: '7',
      anrufArt: 'gruppe',
      channelId: '42',
      einleiterId: '5',
      einleiterName: 'Ada'
    }),
    {
      aktion: 'annehmen',
      callId: '7',
      anruf_art: 'gruppe',
      channel_id: '42',
      einleiter_id: '5',
      einleiter_name: 'Ada'
    }
  );
  assert.deepEqual(alsAnrufAktion({ aktion: 'ablehnen', callId: '7' }), {
    aktion: 'ablehnen',
    callId: '7'
  });
});

test('Ausstehende Aktion: nichts aufbewahrt, Unsinn oder ältere Hülle — nichts zu tun', () => {
  assert.equal(alsAnrufAktion({}), null);
  assert.equal(alsAnrufAktion(null), null);
  assert.equal(alsAnrufAktion({ callId: '7' }), null, 'ohne Entscheidung kein Ereignis');
  assert.equal(alsAnrufAktion({ aktion: 'annehmen' }), null, 'ohne Kennung kein Ereignis');
  assert.equal(alsAnrufAktion({ aktion: 'auflegen', callId: '7' }), null);
});

test('Klingelnder Anruf vom Zettel: kommt als eingehend an, nur ohne Entscheidung', () => {
  const zettel = {
    callId: '7',
    anrufArt: 'video',
    channelId: '42',
    einleiterId: '5',
    einleiterName: 'Ada'
  };
  assert.deepEqual(alsKlingelnderAnruf(zettel), {
    anruf: { call_id: '7', art: 'dm', channel_id: '42', einleiter_id: '5' },
    name: 'Ada'
  });
  assert.equal(alsKlingelnderAnruf({ ...zettel, anrufArt: 'gruppe' })?.anruf.art, 'gruppe');
  // Mit Entscheidung ist es keine Klingel-Angabe, sondern eine Aktion.
  assert.equal(alsKlingelnderAnruf({ ...zettel, aktion: 'annehmen' }), null);
  assert.equal(alsAnrufAktion(zettel), null);
  // Ohne Kanal lässt sich kein Anruf-Zustand bauen.
  assert.equal(alsKlingelnderAnruf({ callId: '7' }), null);
  assert.equal(alsKlingelnderAnruf({}), null);
  assert.deepEqual(alsKlingelnderAnruf({ callId: '7', channelId: '42' }), {
    anruf: { call_id: '7', art: 'dm', channel_id: '42', einleiter_id: '' },
    name: null
  });
});

// ── Befund 11: beim Server-Wechsel bleiben die Kanäle des Kontos ────────────

test('nurBehalten: DMs und Gruppen bleiben, Community-Kanäle fallen', () => {
  const konto = new Set(['dm1', 'gruppe1']);
  assert.deepEqual(
    nurBehalten({ dm1: '9', gruppe1: '8', kanal1: '7' }, (k) => konto.has(k)),
    { dm1: '9', gruppe1: '8' }
  );
  assert.deepEqual(nurBehalten({ kanal1: '7' }, () => false), {});
});
