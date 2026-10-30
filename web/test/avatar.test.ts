import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeAvatarUrl } from '../src/lib/avatar.ts';

/** Security-Scan 2026-10-24 (Nieder): `safeAvatarUrl` als einzige Filterstelle
 *  für avatar_url-Werte in `<img src>` — gleiche Origin (`/…`) oder absolutes
 *  https. Alles andere (null, http:, javascript:, data:, protokoll-relativ)
 *  wird abgelehnt, damit die Verbraucher auf die Initialen-Bahn fallen. */

test('same-origin-Pfad und absolutes https werden durchgelassen', () => {
  assert.equal(safeAvatarUrl('/api/chat/avatars/1.webp'), '/api/chat/avatars/1.webp');
  assert.equal(safeAvatarUrl('https://howispulse.com/a.png'), 'https://howispulse.com/a.png');
});

test('leer/undefiniert bleibt null', () => {
  assert.equal(safeAvatarUrl(null), null);
  assert.equal(safeAvatarUrl(undefined), null);
  assert.equal(safeAvatarUrl(''), null);
});

test('gefährliche Schemata werden abgelehnt', () => {
  for (const url of [
    'http://howispulse.com/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'vbscript:x',
    'blob:https://evil.example/xyz'
  ]) {
    assert.equal(safeAvatarUrl(url), null, url);
  }
});

test('RED-24.10.: protokoll-relative URLs gelten als unsicher', () => {
  // `//evil.example/t.png` beginnt mit `/`, wäre aber gegen ein fremdes
  // Schema/Host aufgelöst worden — Durchreichen wäre ein offener
  // Bild-Load von einer Angreifer-Origin.
  assert.equal(safeAvatarUrl('//evil.example/t.png'), null);
  assert.equal(safeAvatarUrl('///evil.example/t.png'), null);
});
