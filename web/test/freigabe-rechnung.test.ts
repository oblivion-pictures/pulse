import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FREIGABE_MAX_DATEIEN,
  STUECK_BYTES,
  base64ZuBytes,
  dateiName,
  inhaltAusAntwort,
  paketIdAusAntwort,
  naechstesStueck,
  normalisiereDateien
} from '../src/lib/freigabe/freigabeRechnung.ts';
import { freigabeAnkommen, freigabeHolen, freigabeLeeren } from '../src/lib/freigabe/freigabeStore.ts';

const datei = (id: string, extra: object = {}) => ({
  id,
  name: `${id}.pdf`,
  mime: 'application/pdf',
  groesse: 1000,
  ...extra
});

test('inhaltAusAntwort: neue Fassung mit Verzeichnis', () => {
  const p = inhaltAusAntwort({ text: 'Link', paketId: 'P1', dateien: [datei('a'), datei('b')], uebersprungen: 2 });
  assert.equal(p?.text, 'Link');
  assert.equal(p?.paketId, 'P1');
  assert.equal(p?.dateien.length, 2);
  assert.equal(p?.uebersprungen, 2);
  assert.equal(p?.bild, null);
});

test('inhaltAusAntwort: alte Fassung (ein Bild als Base64) und Android bleiben gültig', () => {
  const p = inhaltAusAntwort({ imageBase64: 'QUJD', imageMime: 'image/png' });
  assert.deepEqual(p?.bild, { base64: 'QUJD', mime: 'image/png' });
  assert.equal(p?.paketId, null);
  assert.deepEqual(p?.dateien, []);
  assert.equal(inhaltAusAntwort({ imageBase64: 'QUJD' })?.bild?.mime, 'image/jpeg');
  assert.equal(inhaltAusAntwort({ text: 'nur Text' })?.text, 'nur Text');
});

test('inhaltAusAntwort: leer oder kaputt liefert null', () => {
  assert.equal(inhaltAusAntwort({}), null);
  assert.equal(inhaltAusAntwort(null), null);
  assert.equal(inhaltAusAntwort({ text: '', imageBase64: '' }), null);
  // Dateien ohne Paketkennung sind nicht abholbar.
  assert.equal(inhaltAusAntwort({ dateien: [datei('a')] }), null);
  // Lauter ungültige Einträge: nichts übrig.
  assert.equal(inhaltAusAntwort({ paketId: 'P', dateien: [{ id: '' }, 5, null] }), null);
});

test('normalisiereDateien: höchstens zehn, nur vollständige, keine leeren', () => {
  const viele = Array.from({ length: 14 }, (_, i) => datei(`d${i}`));
  assert.equal(normalisiereDateien(viele).length, FREIGABE_MAX_DATEIEN);
  const gemischt = normalisiereDateien([
    datei('ok'),
    datei('null', { groesse: 0 }),
    datei('neg', { groesse: -5 }),
    datei('nan', { groesse: Number.NaN }),
    { name: 'ohne id', groesse: 5 }
  ]);
  assert.deepEqual(gemischt.map((d) => d.id), ['ok']);
  assert.equal(normalisiereDateien([{ id: 'x', groesse: 3 }])[0].mime, 'application/octet-stream');
  assert.deepEqual(normalisiereDateien('kaputt'), []);
});

test('naechstesStueck: Stücke bis zum Ende, danach 0', () => {
  const groesse = STUECK_BYTES * 2 + 100;
  let offset = 0;
  const laengen: number[] = [];
  for (let n = naechstesStueck(offset, groesse); n > 0; n = naechstesStueck(offset, groesse)) {
    laengen.push(n);
    offset += n;
  }
  assert.deepEqual(laengen, [STUECK_BYTES, STUECK_BYTES, 100]);
  assert.equal(offset, groesse);
  assert.equal(naechstesStueck(0, 10), 10);
  assert.equal(naechstesStueck(10, 10), 0);
  assert.equal(naechstesStueck(-1, 10), 0);
});

test('dateiName: gelieferter Name, sonst geteilt N mit Endung aus dem Typ', () => {
  assert.equal(dateiName(' Rechnung.pdf ', 'application/pdf', 1), 'Rechnung.pdf');
  assert.equal(dateiName('', 'image/jpeg', 2), 'geteilt 2.jpeg');
  assert.equal(dateiName('', 'application/octet-stream', 3), 'geteilt 3');
  assert.equal(dateiName('  ', 'image/svg+xml', 4), 'geteilt 4.svg');
});

test('base64ZuBytes', () => {
  assert.deepEqual([...base64ZuBytes('QUJD')], [65, 66, 67]);
  assert.equal(base64ZuBytes('').length, 0);
});

test('Store: Dateien kommen mit Kennung an, ein zweiter Share ersetzt sie', () => {
  freigabeLeeren();
  freigabeAnkommen({ text: 'x', dateien: [datei('a')], paketId: 'P1', uebersprungen: 1 });
  const p = freigabeHolen();
  assert.equal(p?.paketId, 'P1');
  assert.equal(p?.dateien?.length, 1);
  assert.equal(p?.uebersprungen, 1);
  freigabeAnkommen({ text: 'nur Text' });
  assert.deepEqual(freigabeHolen(), { text: 'nur Text', bild: null });
  // Dateien ohne Paketkennung zählen nicht.
  freigabeAnkommen({ dateien: [datei('a')], paketId: null });
  assert.equal(freigabeHolen(), null);
  freigabeLeeren();
});

test('paketIdAusAntwort: die rohe Kennung bleibt auch bei nur ungültigen Einträgen greifbar', () => {
  const roh = { paketId: 'P', dateien: [{ id: '' }, 5, null] };
  assert.equal(inhaltAusAntwort(roh), null);
  assert.equal(paketIdAusAntwort(roh), 'P');
  assert.equal(paketIdAusAntwort({ text: 'x' }), null);
  assert.equal(paketIdAusAntwort(null), null);
});
