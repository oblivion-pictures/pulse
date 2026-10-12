import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeAusHash, codeNormalisieren } from '../src/lib/verbinden/code.ts';

test('gibt die Anzeigeform zurück, egal wie getippt', () => {
  for (const roh of [
    'K7QM-2XDP',
    'k7qm-2xdp',
    'K7QM2XDP',
    ' k7qm 2xdp ',
    'K7QM - 2XDP',
    'k-7-q-m-2-x-d-p'
  ]) {
    assert.equal(codeNormalisieren(roh), 'K7QM-2XDP', roh);
  }
});

test('verwechselbare Buchstaben werden zu Ziffern (wie die Cloud)', () => {
  assert.equal(codeNormalisieren('OOOO-IIII'), '0000-1111');
  assert.equal(codeNormalisieren('oooo-llll'), '0000-1111');
});

test('alles andere ist kein Code', () => {
  for (const roh of [
    '',
    'K7QM-2XD',
    'K7QM-2XDPQ',
    'K7QM-2XDU', // U gehört nicht zu Crockford-Base32
    'K7QM-2XD!',
    'K7QM_2XDP',
    'x'.repeat(40)
  ]) {
    assert.equal(codeNormalisieren(roh), null, roh);
  }
});

test('liest den Code hinter dem #', () => {
  assert.equal(codeAusHash('#K7QM-2XDP'), 'K7QM-2XDP');
  assert.equal(codeAusHash('#k7qm%202xdp'), 'K7QM-2XDP');
  assert.equal(codeAusHash('K7QM-2XDP'), 'K7QM-2XDP');
});

test('leerer oder kaputter Hash ergibt null', () => {
  for (const h of ['', '#', '#%E0%A4%A', '#nichts']) {
    assert.equal(codeAusHash(h), null, h);
  }
});
