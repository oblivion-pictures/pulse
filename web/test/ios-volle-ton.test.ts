import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// L2/L3 der Prüfung „Volle Tonqualität" (2026-10-17). Die Hülle hat kein
// Swift-Testziel; gehalten wird am Quelltext, wie die übrigen Verträge.
// Eigentümer-Entscheid 2026-10-17: „Volle Tonqualität" gibt es nicht mehr —
// es gilt Apples VPIO. Web-Seite (Schalter, Einstellung) und nativer Weg sind
// entfernt; geprüft wird hier, dass die Hülle ihn nicht wieder enthält (L2).

const swift = (f: string) =>
  readFileSync(new URL(`../../mobile/ios/App/App/${f}`, import.meta.url), 'utf8');

test('L2: der native „Volle Tonqualität"-Weg ist entfernt, die Software-Verarbeitung bleibt für Bluetooth-HQ', () => {
  const alle = ['SpracheRaum.swift', 'SpracheRaumNeustart.swift', 'SpracheRaumStumm.swift', 'SprachePlugin.swift',
    'SpracheFunkHq.swift', 'SpracheFunkHqAbgleich.swift', 'SpracheRaumSession.swift']
    .map(swift)
    .join('\n');
  assert.doesNotMatch(alle, /TonOptionen|volleTonZurueck|volleVerarbeitung|kbpsBegrenzt|ton\.volle/);
  const neustart = swift('SpracheRaumNeustart.swift');
  assert.match(
    neustart,
    /static let softwareVerarbeitung = AudioProcessingOptions\(\s*echoCancellationMode: \.software, autoGainControlMode: \.software,\s*noiseSuppressionMode: \.software\)/
  );
  assert.match(swift('SpracheFunkHqAbgleich.swift'), /try spur\.setAudioProcessingOptions\(software \? Self\.softwareVerarbeitung : AudioProcessingOptions\(\)\)/);
  assert.match(swift('SpracheRaum.swift'), /let r = Room\(delegate: self, roomOptions: Self\.raumOptionen\(\)\)/);
});

test('L3: Beitritt meldet vpio, aec und kbps', () => {
  const neustart = swift('SpracheRaumNeustart.swift');
  assert.match(neustart, /"vpio": am\.platformVoiceProcessingState\.voiceProcessingEnabled\.isActive/);
  assert.match(neustart, /"aec": AudioManager\.shared\.audioProcessingState\.echoCancellation\.effective\.description/);
  assert.match(neustart, /"kbps": AudioEncoding\.presetMusic\.maxBitrate \/ 1000/);
  assert.match(swift('SpracheRaum.swift'), /diagMelden\(art, tonBeleg\(\)\.merging/);
});
