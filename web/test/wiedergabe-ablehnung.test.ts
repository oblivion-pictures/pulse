import test from 'node:test';
import assert from 'node:assert/strict';
import { fehlerName, wiedergabeFehlschlag } from '../src/lib/voice/wiedergabeAblehnung.ts';

const fehler = (name: string) => Object.assign(new Error(name), { name });
const warten = () => new Promise((r) => setTimeout(r, 0));

test('fehlerName: Name des Fehlers, sonst „unbekannt"', () => {
  assert.equal(fehlerName(fehler('AbortError')), 'AbortError');
  assert.equal(fehlerName(null), 'unbekannt');
  assert.equal(fehlerName('kaputt'), 'unbekannt');
  assert.equal(fehlerName({ name: '' }), 'unbekannt');
});

test('NotAllowedError ist eine Sperre — ohne zweiten Anlauf', async () => {
  let anlaeufe = 0;
  const gemeldet: string[] = [];
  const anchor = { play: async () => void anlaeufe++ };
  wiedergabeFehlschlag(anchor, fehler('NotAllowedError'), (g) => gemeldet.push(g));
  await warten();
  assert.equal(anlaeufe, 0);
  assert.deepEqual(gemeldet, ['NotAllowedError']);
});

test('alles andere bekommt genau einen zweiten Anlauf', async () => {
  const gemeldet: string[] = [];
  let anlaeufe = 0;
  wiedergabeFehlschlag({ play: async () => void anlaeufe++ }, fehler('AbortError'), (g) => gemeldet.push(g));
  await warten();
  assert.equal(anlaeufe, 1);
  assert.deepEqual(gemeldet, [], 'der zweite Anlauf ging durch');

  const zweimal: string[] = [];
  const abgelehnt = { play: () => Promise.reject(fehler('NotAllowedError')) };
  wiedergabeFehlschlag(abgelehnt, fehler('AbortError'), (g) => zweimal.push(g));
  await warten();
  assert.deepEqual(zweimal, ['AbortError → NotAllowedError']);
});
