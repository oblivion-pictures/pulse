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

test('B1: „springt nicht an" wird erst im verzögerten Abgleich gewertet', () => {
  const q = swift('SpracheFunkHqAbgleich.swift');
  assert.match(q, /if grund == Self\.funkPruefGrund, !f\.gescheitert,/);
  assert.match(q, /static let funkPruefFrist: TimeInterval = 3/);
  assert.match(q, /asyncAfter\(deadline: \.now\(\) \+ Self\.funkPruefFrist\)/);
});

test('B3: Kopfhörer raus → sofort im Beobachter zurück und stumm, bis VPIO läuft', () => {
  const sitzung = swift('SpracheRaumSession.swift');
  assert.match(sitzung, /SpracheFunkHq\.geteilt\.kopfhoererWeg\(volle: ton\.volle\)\n\s*schickeEigenen\(\)\n\s*funkHqAnstossen\("route"\)/);
  const q = swift('SpracheFunkHq.swift');
  assert.match(q, /guard haelt, !haltenErlaubt\(FunkLage\.lesen\(\)\) else \{ return \}\n\s*if !volle \{ daempfen\(\) \}\n\s*loslassen\(\)/);
  const d = swift('SpracheFunkHqDaempfung.swift');
  assert.match(d, /mixer\.outputVolume = 0/);
  assert.match(d, /voiceProcessingEnabled\.isActive/);
});

test('B4: nur die aktuelle Route, Bluetooth-Eingang und Sprechprofil verlangt', () => {
  const q = swift('SpracheFunkHqAbgleich.swift');
  assert.doesNotMatch(q, /s\.availableInputs/);
  assert.match(q, /let mikros = route\.inputs\.compactMap\(\\\.bluetoothMicrophoneExtension\)/);
  assert.match(q, /return lage\.ausgangSprech && lage\.eingangFunk && lage\.hqKann == true/);
});

test('B5: nach den Heilwegen des Wächters gleicht der Bluetooth-Weg nach', () => {
  const n = swift('SpracheRaumNeustart.swift');
  for (const g of ['maschine_neu', 'maschine_frei', 'spur_neu']) {
    assert.match(n, new RegExp(`funkHqAnstossen\\("${g}"\\)`), g);
  }
});

test('B6: nach einem Anruf ohne CallKit kommt HQ zurück, wenn der Anruf-Raum weg ist', () => {
  assert.match(
    swift('AnrufSitzung.swift'),
    /await AnrufRaum\.geteilt\.verlassen\(nur: kennung\)\n\s*SpracheRaum\.geteilt\.funkHqAnstossen\("anruf_raum_weg"\)/
  );
});

test('B7: Zustand hinter der Sperre, kein main.sync im Bluetooth-Weg', () => {
  const q = swift('SpracheFunkHq.swift') + swift('SpracheFunkHqAbgleich.swift');
  assert.doesNotMatch(q, /DispatchQueue\.main\.sync/);
  assert.match(swift('SpracheFunkHq.swift'), /var gescheitert: Bool \{\n\s*get \{ sperre\.withLock \{ _gescheitert \} \}/);
  assert.match(swift('SpracheFunkHq.swift'), /func artGewechselt\(_ kurz: String\) -> Bool/);
});

test('C1: Halten nur für dasselbe Gerät (uid) und mit Bluetooth-Eingang', () => {
  const q = swift('SpracheFunkHq.swift');
  assert.match(q, /guard l\.ausgangFunk, uid == nil \|\| l\.ausgangUid == uid else \{ return false \}/);
  assert.match(q, /guard haelt, !haltenErlaubt\(FunkLage\.lesen\(\)\) else \{ return \}/);
  assert.match(swift('SpracheFunkHqAbgleich.swift'), /if haelt \{ return haltenOk \}/);
});

test('C2: Fristen der Dämpfung ab der Rückgabe, Obergrenze als eigener Zeitgeber', () => {
  const d = swift('SpracheFunkHqDaempfung.swift');
  assert.match(d, /asyncAfter\(deadline: \.now\(\) \+ Self\.hoechstens\) \{ \[self\] in\n\s*aus\(grund: "hoechstens", runde: r\)/);
  assert.match(d, /if zurueckSeit == nil \{ zurueckSeit = CFAbsoluteTimeGetCurrent\(\) \}/);
  // Frist vor den blockierenden Gettern.
  assert.ok(d.indexOf('Self.ohneVpio {') < d.indexOf('am.audioProcessingState'));
});

test('C3: ein Abriss während HQ deaktiviert die Session wie nach dem letzten Stream-Ton', () => {
  const r = swift('SpracheRaum.swift');
  assert.match(r, /let hielt = SpracheFunkHq\.geteilt\.haelt\n\s*raumLoesen\(r\)\n\s*if hielt \{ SpracheFunkHq\.geteilt\.nachAbriss\(\) \}/);
  assert.match(swift('SpracheFunkHq.swift'), /guard !laeuft else \{ return \}\n\s*StreamTonSitzung\.geteilt\.nachDemLetzten\(\)/);
  assert.match(swift('StreamTonSitzung.swift'), /\n    func nachDemLetzten\(\) \{/);
});

test('C4: „verloren" beim Einrichten ist kein Fehlschlag für den ganzen Raum', () => {
  const q = swift('SpracheFunkHqAbgleich.swift');
  assert.match(q, /let abgebrochen = fehler == SpracheFunkHq\.verlorenGrund\n\s*if !abgebrochen \{ f\.gescheitert = true \}/);
  assert.match(q, /"funk_hq_abgebrochen"/);
});
