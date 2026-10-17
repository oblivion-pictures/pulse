import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// L2/L3 der Prüfung „Volle Tonqualität" (2026-10-17). Die Hülle hat kein
// Swift-Testziel; gehalten wird am Quelltext, wie die übrigen Verträge.

const swift = (f: string) =>
  readFileSync(new URL(`../../mobile/ios/App/App/${f}`, import.meta.url), 'utf8');

test('L2: nach der Anruf-Pause gilt „Volle Tonqualität" wieder', () => {
  assert.match(swift('SpracheRaumStumm.swift'), /if !an, ton\.volle, let r = raum \{ volleTonZurueck\(in: r\) \}/);
  const neustart = swift('SpracheRaumNeustart.swift');
  assert.match(neustart, /try spur\.setAudioProcessingOptions\(Self\.volleVerarbeitung\)/);
  assert.match(
    neustart,
    /static let volleVerarbeitung = AudioProcessingOptions\(\s*echoCancellationMode: \.software, autoGainControlMode: \.software,\s*noiseSuppressionMode: \.software\)/
  );
  assert.match(swift('SpracheRaum.swift'), /self\.ton = ton\n\s*let r = Room\(delegate: self, roomOptions: Self\.raumOptionen\(ton\)\)/);
});

test('L3: Beitritt meldet vpio, aec und kbps', () => {
  const neustart = swift('SpracheRaumNeustart.swift');
  assert.match(neustart, /"vpio": am\.platformVoiceProcessingState\.voiceProcessingEnabled\.isActive/);
  assert.match(neustart, /"aec": AudioManager\.shared\.audioProcessingState\.echoCancellation\.effective\.description/);
  assert.match(neustart, /"kbps": ton\.volle \? \(Self\.kbpsBegrenzt\(ton\) \?\? vorgabe\) : vorgabe/);
  assert.match(swift('SpracheRaum.swift'), /diagMelden\(art, tonBeleg\(ton\)\.merging/);
});
