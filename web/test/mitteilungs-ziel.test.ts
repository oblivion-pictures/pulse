import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mitteilungsZiel } from '../src/lib/platform/mitteilungsZiel.ts';

/**
 * iOS-Bughunt 2, C4: ein Tipp auf die Mitteilung eines Ablage-Kanals öffnete
 * `/app/@me/<kanal>` („DM nicht gefunden"), und eine Banner-Antwort blieb
 * liegen. Das Ziel richtet sich jetzt nach der Kanalart.
 */

const keineGilde = () => null;

test('DM und private Gruppe: wie bisher unter @me, die Antwort wird dort gesendet', () => {
  assert.deepEqual(mitteilungsZiel({ channel_id: '42' }, keineGilde), {
    pfad: '/app/@me/42',
    kanalId: '42',
    antwortWirdGesendet: true
  });
});

test('Gilden-Kanal aus dem Wissen des Klienten: Kanal-Route, Antwort nur als Entwurf', () => {
  const ziel = mitteilungsZiel({ channel_id: '42' }, (k) => (k === '42' ? '7' : null));
  assert.deepEqual(ziel, {
    pfad: '/app/guilds/7/channels/42',
    kanalId: '42',
    antwortWirdGesendet: false
  });
});

test('guild_id aus der Nutzlast hat Vorrang', () => {
  const ziel = mitteilungsZiel({ channel_id: '42', guild_id: '9' }, keineGilde);
  assert.equal(ziel?.pfad, '/app/guilds/9/channels/42');
});

test('ohne Kanal kein Ziel; Unsinn in der Nutzlast fällt heraus', () => {
  assert.equal(mitteilungsZiel({}, keineGilde), null);
  assert.equal(mitteilungsZiel(null, keineGilde), null);
  assert.equal(mitteilungsZiel('42', keineGilde), null);
  assert.equal(mitteilungsZiel({ channel_id: { x: 1 } }, keineGilde), null);
  assert.equal(mitteilungsZiel({ channel_id: '42', guild_id: '' }, keineGilde)?.pfad, '/app/@me/42');
});
