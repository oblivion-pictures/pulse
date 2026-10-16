import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Funde der Gegenprüfung vom 2026-10-17 zu fix/ios-ton-sitzung (T1–T7). Die
// Hülle hat kein Swift-Testziel; was nur dort liegt, wird am Quelltext
// gehalten — so wie die übrigen Verträge zwischen Web und Hülle.

const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const swift = (f: string) => lesen(`../../mobile/ios/App/App/${f}`);

test('T2: „CallKit hängt" nicht im regulären Rückgabe-Fenster', () => {
  const n = swift('SpracheRaumNeustart.swift');
  assert.match(n, /!fremd && !v\.sessionAktiv && v\.rueckgabeUhr == nil/);
  const herstellen = /func sitzungFrischHerstellen\(\) async \{[\s\S]*?\n {4}\}/.exec(n)?.[0] ?? '';
  assert.match(herstellen, /async \{\n {8}await rueckgabeAbwarten\(\)/);
});
