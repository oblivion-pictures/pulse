import test from 'node:test';
import assert from 'node:assert/strict';
import { kameraAufloesung } from '../src/lib/voice/kameraAufloesung.ts';

test('kameraAufloesung nimmt die Stufe der Instanz', () => {
  assert.deepEqual(kameraAufloesung('1440p', 30), { width: 2560, height: 1440, frameRate: 30 });
  assert.deepEqual(kameraAufloesung('1080p', 60), { width: 1920, height: 1080, frameRate: 60 });
  assert.deepEqual(kameraAufloesung('480p', 15), { width: 854, height: 480, frameRate: 15 });
});

test('kameraAufloesung fällt bei unbekannter Stufe auf 720p zurück', () => {
  assert.deepEqual(kameraAufloesung('4k', 30), { width: 1280, height: 720, frameRate: 30 });
  assert.deepEqual(kameraAufloesung('', 30), { width: 1280, height: 720, frameRate: 30 });
});

test('kameraAufloesung begrenzt die Bildrate auf 1..60, 0 heißt 30', () => {
  assert.equal(kameraAufloesung('720p', 0).frameRate, 30);
  assert.equal(kameraAufloesung('720p', 120).frameRate, 60);
  assert.equal(kameraAufloesung('720p', -5).frameRate, 1);
  assert.equal(kameraAufloesung('720p', 24).frameRate, 24);
});
