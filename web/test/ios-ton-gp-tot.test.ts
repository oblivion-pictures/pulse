import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Funde der Gegenprüfung vom 2026-10-17 zu fix/ios-ton-sitzung (T1–T7). Die
// Hülle hat kein Swift-Testziel; was nur dort liegt, wird am Quelltext
// gehalten — so wie die übrigen Verträge zwischen Web und Hülle.

const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const swift = (f: string) => lesen(`../../mobile/ios/App/App/${f}`);

test('T7: „Mikrofon tot" übersteht einen Reload, der Knopf nur mit passender Web-App', () => {
  assert.match(swift('SpracheRaumZustand.swift'), /"mikroTot": wache\.tot/);
  assert.match(lesen('../src/lib/voice/nativerRaum.svelte.ts'), /if \(z\.mikroTot !== undefined\) this\.mikroTot = z\.mikroTot;/);
  assert.match(swift('SprachePlugin.swift'), /call\.getBool\("kannNeuVerbinden"\)/);
  assert.match(lesen('../src/lib/platform/iosSprache.ts'), /kannNeuVerbinden: true/);
  assert.match(swift('SpracheAnsicht.swift'), /if stand\.neuVerbindenMoeglich \{/);
});
