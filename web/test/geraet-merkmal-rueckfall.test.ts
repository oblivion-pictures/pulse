import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverKenntGeraetMerkmalNicht } from '../src/lib/stream/geraetMerkmalRueckfall.ts';

// So antwortet ein älterer Server (Pydantic `extra="forbid"`) auf `device_id`.
const altServer = {
  detail: [
    {
      type: 'extra_forbidden',
      loc: ['body', 'device_id'],
      msg: 'Extra inputs are not permitted',
      input: '123',
    },
  ],
};

test('alter Server: 422 extra_forbidden an device_id → einmal ohne wiederholen', () => {
  assert.equal(serverKenntGeraetMerkmalNicht(422, altServer), true);
});

test('anderer 422 (kaputte ID, fremdes Feld) bleibt ein Fehler', () => {
  const kaputteId = { detail: [{ type: 'int_parsing', loc: ['body', 'device_id'] }] };
  assert.equal(serverKenntGeraetMerkmalNicht(422, kaputteId), false);
  const fremdesFeld = { detail: [{ type: 'extra_forbidden', loc: ['body', 'codec'] }] };
  assert.equal(serverKenntGeraetMerkmalNicht(422, fremdesFeld), false);
  assert.equal(serverKenntGeraetMerkmalNicht(422, { detail: 'kaputt' }), false);
  assert.equal(serverKenntGeraetMerkmalNicht(422, null), false);
});

test('andere Statuscodes nie (403 = Gerät gehört nicht dir, bleibt Absage)', () => {
  assert.equal(serverKenntGeraetMerkmalNicht(403, altServer), false);
  assert.equal(serverKenntGeraetMerkmalNicht(400, altServer), false);
  assert.equal(serverKenntGeraetMerkmalNicht(500, altServer), false);
});
