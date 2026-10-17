import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { WebAufnahme, type Geraete } from '../src/lib/platform/webAufnahme.ts';
import { StreamTonLage, lageAus, type Lage } from '../src/lib/stream/streamTonLage.ts';

// Gegenprüfung 2026-10-17, S1 (b): eine Aufnahme der WebView darf nie unter
// WebKits `ambient` laufen — der Halter `streamton` muss VOR dem eigentlichen
// `getUserMedia` fallen und danach wiederkommen.

function kachel() {
  const lagen: Lage[] = [];
  return { lagen, lageSetzen: (l: Lage) => lagen.push(l) };
}

test('Aufnahme mit laufender Kachel: Halter fällt vor getUserMedia, Kachel setzt aus', async () => {
  const halter: boolean[] = [];
  const lage = new StreamTonLage((an) => halter.push(an));
  const k = kachel();
  lage.anmelden(k);
  lage.wollen(k, true);
  assert.deepEqual(halter, [true]);

  let halterBeimRuf: boolean | null = null;
  const spur = { kind: 'audio', readyState: 'live' };
  const geraete: Geraete = {
    getUserMedia: async () => {
      halterBeimRuf = halter[halter.length - 1];
      return { getTracks: () => [spur] };
    }
  };
  const aufnahme = new WebAufnahme((a) => lage.setzen({ aufnahme: a }));
  aufnahme.einhaengen(geraete);
  await geraete.getUserMedia({ audio: true });
  assert.equal(halterBeimRuf, false, 'Halter muss beim Ruf schon gefallen sein');
  assert.deepEqual(k.lagen, ['pause']);
  assert.equal(aufnahme.aktiv, true);

  // `track.stop()` feuert kein `ended` — der Zustand der Spur zählt.
  spur.readyState = 'ended';
  aufnahme.pruefen();
  assert.equal(aufnahme.aktiv, false);
  assert.deepEqual(k.lagen, ['pause', 'nativ']);
  // Die Kachel startet selbst neu (`wollen`), erst dann hält der Halter wieder.
  lage.wollen(k, true);
  assert.deepEqual(halter, [true, false, true]);
});

test('gescheiterte Aufnahme und Rufe ohne Ton', async () => {
  const lage = new StreamTonLage(() => undefined);
  const aufnahme = new WebAufnahme((a) => lage.setzen({ aufnahme: a }));
  const geraete: Geraete = {
    getUserMedia: async (c) => {
      if ((c as { audio?: boolean }).audio) throw new Error('NotAllowedError');
      return { getTracks: () => [{ kind: 'video', readyState: 'live' }] };
    }
  };
  aufnahme.einhaengen(geraete);
  await assert.rejects(geraete.getUserMedia({ audio: true }));
  assert.equal(aufnahme.aktiv, false);
  await geraete.getUserMedia({ video: true });
  assert.equal(aufnahme.aktiv, false, 'nur Bild verändert WebKits Ton-Session nicht');
});

test('Lage: Aufnahme geht vor', () => {
  assert.equal(lageAus({ aufnahme: false, webWiedergabe: false, raum: false }), 'nativ');
  assert.equal(lageAus({ aufnahme: true, webWiedergabe: false, raum: true }), 'pause');
});

test('ohne Kachel, die nativ spielen will, kein Halter', () => {
  const halter: boolean[] = [];
  const lage = new StreamTonLage((an) => halter.push(an));
  lage.setzen({ aufnahme: true });
  lage.setzen({ aufnahme: false });
  assert.deepEqual(halter, []);
});
