import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kanonischeAntwortId } from '../src/lib/krypto/kanonischeAntwortId.ts';

test('ohne Antwortbezug bleibt es null', () => {
  assert.equal(kanonischeAntwortId(null, []), null);
});

test('Ziel mit krypto_id (empfangene Nachricht) wird auf die kanonische ID uebersetzt', () => {
  const nachrichten = [{ id: 'lokal-zustellung-9', krypto_id: 'autor-42' }];
  assert.equal(kanonischeAntwortId('lokal-zustellung-9', nachrichten), 'autor-42');
});

test('Ziel ohne krypto_id (eigene Nachricht aus dem Altbestand) bleibt bei der lokalen ID', () => {
  const nachrichten = [{ id: 'eigene-id-7' }];
  assert.equal(kanonischeAntwortId('eigene-id-7', nachrichten), 'eigene-id-7');
});

test('eigene Nachricht seit 2026-10-13 (krypto_id = id) bleibt bei derselben ID', () => {
  const nachrichten = [{ id: 'eigene-id-8', krypto_id: 'eigene-id-8' }];
  assert.equal(kanonischeAntwortId('eigene-id-8', nachrichten), 'eigene-id-8');
});

test('unbekanntes Ziel (z. B. Klartext-Nachricht) faellt auf die uebergebene ID zurueck', () => {
  assert.equal(kanonischeAntwortId('server-id-1', []), 'server-id-1');
});
