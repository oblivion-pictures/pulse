import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Bluetooth in hoher Qualität im nativen Sprachkanal (`SpracheFunkHq*.swift`).
// Die Hülle hat kein Swift-Testziel; gehalten wird am Quelltext, wie bei
// „Volle Tonqualität" (`ios-volle-ton.test.ts`). Was nur am Gerät zu belegen
// ist (Route, Codec), steht in der Diagnose-Zeile, nicht hier.

const swift = (f: string) =>
  readFileSync(new URL(`../../mobile/ios/App/App/${f}`, import.meta.url), 'utf8');

test('die Option hängt HINTER dem Session-Beobachter des SDK, vor dem Mischer', () => {
  assert.match(
    swift('SpracheFunkHq.swift'),
    /am\.set\(engineObservers: \[am\.audioSession, FunkHqMaschine\(\), am\.mixer\]\)/
  );
});

test('die Option nur an playAndRecord, gesetzt nur im Modus .default (Apple-Kopf)', () => {
  const q = swift('SpracheFunkHq.swift');
  assert.match(q, /s\.category == \.playAndRecord/);
  assert.match(q, /!soll \|\| s\.mode == \.default/);
  assert.match(q, /#available\(iOS 26\.0, \*\)/);
});

test('HQ nur mit Bluetooth-Ausgabe, iOS 26, Wunsch und einem Kopfhörer, der es kann', () => {
  const q = swift('SpracheFunkHqAbgleich.swift');
  assert.match(q, /guard wunsch, lage\.ios26, lage\.ausgangFunk, !gescheitert else \{ return false \}/);
  assert.match(q, /return lage\.hqKann \?\? bisher/);
  assert.match(q, /highQualityRecording\.isSupported/);
});

test('der Weg folgt der Route, dem Anruf-Ende und dem Beitritt', () => {
  assert.match(swift('SpracheRaumSession.swift'), /funkHqAnstossen\("route"\)/);
  assert.match(swift('SpracheRaumStumm.swift'), /funkHqAbgleichen\("anruf_ende"\)/);
  assert.match(swift('SpracheRaum.swift'), /await funkHqAbgleichen\("beitritt"\)/);
  assert.match(swift('SpracheRaum.swift'), /SpracheFunkHq\.geteilt\.raumWeg\(\)/);
});

test('jede Diagnose-Zeile sagt, welcher Weg lief', () => {
  assert.match(swift('SpracheRaumNeustart.swift'), /\]\.merging\(funkFelder\(\)\) \{ \$1 \}/);
  const q = swift('SpracheFunkHqAbgleich.swift');
  for (const feld of ['ios', 'funkArt', 'hqOpt', 'hqKann', 'hqAn', 'rate']) {
    assert.match(q, new RegExp(`"${feld}":`), feld);
  }
});

test('der Brückenschalter existiert in der Hülle', () => {
  assert.match(swift('SprachePlugin.swift'), /CAPPluginMethod\(name: "funkHq"/);
  assert.match(swift('SprachePlugin.swift'), /SpracheFunkHq\.geteilt\.wunsch = call\.getBool\("an"\) \?\? true/);
});
