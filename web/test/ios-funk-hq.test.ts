import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Bluetooth in hoher Qualität im nativen Sprachkanal (`SpracheFunkHq*.swift`).
// Die Hülle hat kein Swift-Testziel; gehalten wird am Quelltext, wie bei
// „Volle Tonqualität" (`ios-volle-ton.test.ts`). Was nur am Gerät zu belegen
// ist (Route, Codec), steht in der Diagnose-Zeile, nicht hier.

const swift = (f: string) =>
  readFileSync(new URL(`../../mobile/ios/App/App/${f}`, import.meta.url), 'utf8');

test('B2: während HQ hält die Hülle die Session selbst (Automatik aus), kein Anhängen ans SDK', () => {
  const q = swift('SpracheFunkHq.swift');
  assert.match(q, /am\.audioSession\.isAutomaticConfigurationEnabled = false\n\s*sperre\.withLock \{ _haelt = true \}/);
  assert.match(q, /try s\.setCategory\(\.playAndRecord, mode: \.default, options: optionen\)/);
  assert.match(q, /optionen\.insert\(\.bluetoothHighQualityRecording\)/);
  assert.doesNotMatch(q, /\.set\(engineObservers:/);
  // Nehmen und Einrichten auf dem Hauptthread, wie die CallKit-Übergabe.
  assert.match(q, /@MainActor func automatikNehmen\(\) -> Bool/);
  assert.match(q, /@MainActor func hqEinrichten\(\) -> String\?/);
});

test('B2: Pendelbremse — mehr als 3 Übernahmen in 30 s, dann VPIO', () => {
  const q = swift('SpracheFunkHq.swift');
  assert.match(q, /static let pendelGrenze = 3/);
  assert.match(q, /static let pendelFenster: CFAbsoluteTime = 30/);
  assert.match(swift('SpracheFunkHqAbgleich.swift'), /diagMelden\("funk_hq_pendelt"/);
});

test('jeder Anruf nimmt dem Kanal die Session sofort wieder ab', () => {
  const a = swift('AnrufSitzung.swift');
  assert.equal(a.match(/SpracheFunkHq\.geteilt\.loslassen\(\)/g)?.length, 2);
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
  for (const feld of ['ios', 'funkArt', 'funkHaelt', 'hqOpt', 'hqKann', 'hqAn', 'rate']) {
    assert.match(q, new RegExp(`"${feld}":`), feld);
  }
});

test('der Brückenschalter existiert in der Hülle', () => {
  assert.match(swift('SprachePlugin.swift'), /CAPPluginMethod\(name: "funkHq"/);
  assert.match(swift('SprachePlugin.swift'), /SpracheFunkHq\.geteilt\.wunsch = call\.getBool\("an"\) \?\? true/);
});
