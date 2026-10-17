import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// L2/L3 der Prüfung „Volle Tonqualität" (2026-10-17). Die Hülle hat kein
// Swift-Testziel; gehalten wird am Quelltext, wie die übrigen Verträge.

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

// Eigentümer-Entscheid 2026-10-17: „Volle Tonqualität" wird nicht angeboten —
// es gilt Apples Sprachverarbeitung (VPIO). Der native Weg ist entfernt (L2).
test('Entscheid: Schalter ausgeblendet, ein gespeichertes „an" greift nicht', async () => {
  const { VOLLE_TONQUALITAET_ANGEBOTEN, volleTonqualitaetWirksam } = await import(
    '../src/lib/platform/iosVolleTon.ts'
  );
  assert.equal(VOLLE_TONQUALITAET_ANGEBOTEN, false);
  assert.equal(volleTonqualitaetWirksam(true), false);
  const web = (p: string) => readFileSync(new URL(`../src/lib/${p}`, import.meta.url), 'utf8');
  assert.match(
    web('voice/nativerRaum.svelte.ts'),
    /volle: volleTonqualitaetWirksam\(settings\.audio\.iosVolleTonqualitaet\)/
  );
  const ui = web('components/settings/IosTonEinstellungen.svelte');
  assert.match(ui, /const volleTonAnbieten = ios && VOLLE_TONQUALITAET_ANGEBOTEN && nativeWacheDa\(\);/);
  assert.match(ui, /\{#if volleTonAnbieten\}\s*\{@render schalter\(\s*'settings-ios-volle-tonqualitaet'/);
});
