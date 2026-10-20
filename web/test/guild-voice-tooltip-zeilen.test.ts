import test from 'node:test';
import assert from 'node:assert/strict';
import { fremdeZeilen, gastName } from '../src/lib/components/guildVoiceTooltipZeilen.ts';

const SPRACHE = 1;

// Befund 2026-10-20: in der Vorschau eines NICHT aktiven Servers stand bei
// einem Gast „gast-1060…“ statt seines Namens. Die REST-Antwort trug den
// Namen, die Zeile warf ihn weg, und die Anzeige suchte ihn im Speicher des
// aktiven Servers, der diesen Kanal nicht kennt.
test('fremder Server: der Gastname aus der REST-Antwort landet in der Zeile', () => {
  const zeilen = fremdeZeilen(
    [{ id: 'k1', name: 'Besprechung', type: SPRACHE }],
    [
      {
        channel_id: 'k1',
        user_ids: ['42', 'gast-7'],
        streaming_user_ids: [],
        camera_user_ids: [],
        gast_namen: { 'gast-7': 'sibylle' }
      }
    ],
    [],
    []
  );
  assert.equal(zeilen.length, 1);
  assert.equal(gastName(zeilen[0], 'gast-7'), 'sibylle');
});

test('ohne Namen bleibt die Kennung als Rückfall, statt den Gast zu verschweigen', () => {
  const [zeile] = fremdeZeilen(
    [{ id: 'k1', name: 'Besprechung', type: SPRACHE }],
    [{ channel_id: 'k1', user_ids: ['gast-7'], streaming_user_ids: [], camera_user_ids: [] }],
    [],
    []
  );
  assert.equal(gastName(zeile, 'gast-7'), 'gast-7');
});

test('leere und Nicht-Sprachkanäle fallen heraus, LIVE und PARTY werden zusammengeführt', () => {
  const zeilen = fremdeZeilen(
    [
      { id: 't', name: 'text', type: 0 },
      { id: 'leer', name: 'leer', type: SPRACHE },
      { id: 'k1', name: 'Besprechung', type: SPRACHE }
    ],
    [
      { channel_id: 't', user_ids: ['1'], streaming_user_ids: [], camera_user_ids: [] },
      { channel_id: 'k1', user_ids: ['1', '2'], streaming_user_ids: ['1'], camera_user_ids: ['2'] }
    ],
    [{ channel_id: 'k1', user_ids: ['1', '2'] }],
    [
      { channel_id: 'k1', state: { host_user_id: '2' } },
      { channel_id: 'k1', state: { host_user_id: '1' } }
    ]
  );
  assert.deepEqual(zeilen, [
    {
      id: 'k1',
      name: 'Besprechung',
      userIds: ['1', '2'],
      streamingUserIds: ['1', '2'],
      camUserIds: ['2'],
      partyHostUserIds: ['2', '1'],
      gastNamen: {}
    }
  ]);
});
