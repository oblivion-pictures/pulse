import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuerErstsicherung, fuerUmzug, istUngeprueft } from '../src/lib/verlauf/herkunft.ts';
import { anhangKandidaten, laufwerkDateien } from '../src/lib/verlauf/loeschFolgen.ts';

// Gegenprüfung 2026-10-12, Fund 4: Sätze aus Archiv-Bestandszeilen ohne
// geprüften Autor werden nie eigene Wahrheit.

const ICH = '200';
type Satz = { geloescht: boolean; autorId: string; anhaenge: { id: string }[]; ungeprueft?: true };
const sicht: Satz = { geloescht: false, autorId: ICH, anhaenge: [{ id: '501' }] };
const stein: Satz = { ...sicht, geloescht: true };
const ungeprueft: Satz = { ...sicht, ungeprueft: true };

test('istUngeprueft liest nur die Marke', () => {
  assert.equal(istUngeprueft(ungeprueft), true);
  assert.equal(istUngeprueft(sicht), false);
});

test('Erstsicherung: weder Grabsteine noch Ungeprüftes', () => {
  assert.deepEqual(fuerErstsicherung([sicht, stein, ungeprueft]), [sicht]);
});

test('Kopplung: Grabsteine reisen mit, Ungeprüftes nicht', () => {
  assert.deepEqual(fuerUmzug([sicht, stein, ungeprueft]), [sicht, stein]);
});

test('Löschfolgen: ein ungeprüfter Satz gibt weder Bytes noch Laufwerk-Dateien frei', () => {
  // Seine Anhang-Liste hat ein Fremder geschrieben, auch wenn er mich als
  // Autor nennt.
  assert.deepEqual(anhangKandidaten([ungeprueft]), []);
  assert.deepEqual(laufwerkDateien(ungeprueft, ICH, new Set(['501'])), []);
  assert.deepEqual(laufwerkDateien(sicht, ICH, new Set(['501'])), ['501']);
});
