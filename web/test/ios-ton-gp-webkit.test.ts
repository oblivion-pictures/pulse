import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Funde der Gegenprüfung vom 2026-10-17 zu fix/ios-ton-sitzung (T1–T7). Die
// Hülle hat kein Swift-Testziel; was nur dort liegt, wird am Quelltext
// gehalten — so wie die übrigen Verträge zwischen Web und Hülle.

const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const swift = (f: string) => lesen(`../../mobile/ios/App/App/${f}`);

test('T6: vor jedem Ton im nativen Raum erklärt sich WebKit als ambient', () => {
  const e = lesen('../src/lib/sounds/engine.ts');
  assert.match(e, /this\.vorWebAudioTon\?\.\(\);/);
  const s = lesen('../src/lib/platform/iosSprache.ts');
  assert.match(s, /if \(an\) sounds\.vorWebAudioTon \?\?= \(\) => webkitNeuErklaeren\('ton'\);/);
  // Nur solange ein Halter da ist — ausserhalb des Raums bleibt `auto`.
  assert.match(s, /export function webkitNeuErklaeren\(grund: string\): void \{\n {2}if \(!halter\.gehalten\) return;/);
});
