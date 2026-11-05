import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * CarPlay-Befund vom 2026-10-25 (ausgewertet am 2026-11-05, Kopf von
 * `SpracheRaumMikroNachholen.swift`): das Mikrofon scheiterte beim Beitritt,
 * die Hülle holt es nach. Die Oberfläche muss
 * ihre Meldung „Mikrofon-Zugriff fehlgeschlagen" dann zurücknehmen — sonst
 * steht sie über einem Mikrofon, das längst läuft. Quelltext-Test, weil
 * `nativerRaum.svelte.ts` Runen und `$lib`-Aliase zieht (`pnpm test:unit`-Falle).
 */
const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');
const huelle = (pfad: string) => readFileSync(new URL(`../../mobile/ios/App/App/${pfad}`, import.meta.url), 'utf8');

test('der eigene Zustand trägt den Mikrofonfehler mit, auch als null', () => {
  assert.match(lies('lib/platform/iosSpracheTypen.ts'), /interface NativerEigenerZustand \{[^}]*mikrofonFehler\?: string \| null;[^}]*\}/);
  assert.match(huelle('SpracheRaumZustand.swift'), /"mikrofonFehler": mikrofonFehler \?\? NSNull\(\)\n\s*\]\.merging\(wunschFelder\)/);
});

test('ein nachgeholtes Mikrofon nimmt die Meldung zurück, eine ältere Hülle nicht', () => {
  const raum = lies('lib/voice/nativerRaum.svelte.ts');
  assert.match(
    raum,
    /if \(e\.mikrofonFehler === null && mikrofonMeldungen\(\)\.includes\(w\.error \?\? ''\)\) \{\s*w\.error = null;/
  );
});

test('mit Erlaubnis heisst es „wird verbunden", nicht „Zugriff fehlgeschlagen"', () => {
  const raum = lies('lib/voice/nativerRaum.svelte.ts');
  assert.match(raum, /w\.error = mikrofonMeldung\(z\.mikrofonErlaubt\);/);
  assert.match(raum, /return erlaubt === true \? m\.livekit_mikrofon_wird_verbunden\(\) : m\.livekit_microphone_access_failed\(\);/);
  assert.match(lies('lib/platform/iosSpracheTypen.ts'), /mikrofonErlaubt\?: boolean;/);
  assert.match(huelle('SpracheRaumZustand.swift'), /"mikrofonErlaubt": Anrufverwaltung\.mikrofonErlaubt\(\),/);
});

test('die Hülle holt nach einem Beitritt ohne Mikrofon nach und meldet den Fehlertext', () => {
  const raum = huelle('SpracheRaum.swift');
  assert.match(raum, /if mikrofonFehler != nil \{ mikrofonNachholen\(sitzung: sitzung\) \}/);
  assert.match(raum, /fehlerFelder = Self\.fehlerFelder\(error\)/);
  const nachholen = huelle('SpracheRaumMikroNachholen.swift');
  assert.match(nachholen, /guard Anrufverwaltung\.mikrofonErlaubt\(\) else \{ return \}/);
  assert.match(nachholen, /"fehlerBereich": ns\.domain, "fehlerCode": ns\.code/);
  const projekt = readFileSync(new URL('../../mobile/ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  assert.match(projekt, /SpracheRaumMikroNachholen\.swift in Sources \*\/,/);
});

test('zweiter Bericht: übrige Spur vor dem Neuversuch abmelden', () => {
  const nachholen = huelle('SpracheRaumMikroNachholen.swift');
  // Sonst „Server state mismatch" (Build 24.1, Versuch 1).
  assert.match(
    nachholen,
    /try await r\.localParticipant\.unpublish\(publication: pub\)\s*\}\s*try await r\.localParticipant\.setMicrophone\(enabled: true\)/
  );
});

test('Auswertung 2026-11-05: kein Neubau der Maschine im Auto, keine Varianten, mehr Geduld', () => {
  const nachholen = huelle('SpracheRaumMikroNachholen.swift');
  // Der Neubau riss den Ton im Auto auf den iPhone-Lautsprecher (zwei Berichte).
  assert.match(nachholen, /if versuch > 1, !auto \{ await maschineNeu\(grund: "mikro_nachholen"\) \}/);
  // Der Versuchsaufbau vom 2026-10-25 ist weg.
  for (const alt of ['carPlayVarianteSetzen', 'carPlayZuruecksetzen', 'setPlatformVoiceProcessingAllowed', 'setPreferredInput']) {
    assert.ok(!nachholen.includes(alt), alt);
  }
  // Länger als die alten 17 s: eine Verbindung, die sich fängt, bekommt ihr Mikrofon.
  assert.match(nachholen, /mikroNachholAbstaende: \[UInt64\] = \[2, 5, 10, 20, 40, 60\]/);
  // Nur die jüngste Reihe läuft weiter.
  assert.match(nachholen, /guard reihe == Self\.nachholReihe else \{ return \}/);
});

test('Auswertung 2026-11-05: jedes Wiederverbinden stösst das Nachholen an', () => {
  const delegat = huelle('SpracheRaumDelegate.swift');
  assert.match(delegat, /if state == \.connected, alt == \.reconnecting \{ nachholenNachWiederverbinden\(\) \}/);
  assert.match(
    huelle('SpracheRaumMikroNachholen.swift'),
    /func nachholenNachWiederverbinden\(\) \{\s*guard raum != nil, mikrofonFehler != nil else \{ return \}\s*mikrofonNachholen\(sitzung: sitzung\)/
  );
});

test('Auswertung 2026-11-05: unter CarPlay vor dem Verbinden vorwärmen, beim Verlassen abschalten', () => {
  const raum = huelle('SpracheRaum.swift');
  assert.match(raum, /let vorgewaermt = await carPlayVorwaermen\(\)\n\s*TonMessung\.geteilt\.beginnen\(\)/);
  assert.match(raum, /\["stumm": stumm, "vorgewaermt": vorgewaermt\]/);
  assert.match(raum, /raum = nil\n[^\n]*\n\s*Self\.vorwaermenBeenden\(\)/);
  const nachholen = huelle('SpracheRaumMikroNachholen.swift');
  // Dieselbe Verarbeitung wie die Spur, sonst schaltet die Maschine beim Veröffentlichen erneut um.
  assert.match(
    nachholen,
    /setRecordingAlwaysPreparedMode\(\s*true, audioProcessingOptions: Self\.vpioVerarbeitung\)/
  );
  assert.match(nachholen, /guard Self\.carPlayAktiv\(\), Anrufverwaltung\.mikrofonErlaubt\(\), !anrufPausiert else \{ return false \}/);
  // Ein später Abschalt-Auftrag des vorigen Raums lässt den nächsten in Ruhe.
  assert.match(nachholen, /guard !Self\.vorgewaermt else \{ return \}/);
});

test('Diagnose-Build: Messung beginnt vor dem Verbinden, endet beim Verlassen, Wechsel werden gemeldet', () => {
  const raum = huelle('SpracheRaum.swift');
  assert.match(raum, /TonMessung\.geteilt\.beginnen\(\)\n\s*let r = Room\(delegate: self, roomOptions: Self\.raumOptionen\(statistik: Self\.statistikNoetig\(\)\)\)/);
  assert.match(raum, /\.merging\(mikroZeit\) \{ \$1 \}\.merging\(TonMessung\.geteilt\.felder\(\)\) \{ \$1 \}/);
  assert.match(raum, /messReiheBeginnen\(sitzung: sitzung\)/);
  assert.match(raum, /private func raumLoesen[\s\S]*?TonMessung\.geteilt\.beenden\(\)[\s\S]*?\n {4}\}/);
  assert.match(huelle('SpracheRaumNeustart.swift'), /reportRemoteTrackStatistics: statistik/);
  const delegat = huelle('SpracheRaumDelegate.swift');
  assert.match(delegat, /diagMelden\("verbindung_wechsel", felder\)/);
  assert.match(delegat, /diagMelden\("getrennt", felder\)/);
  const messung = huelle('SpracheRaumMessung.swift');
  assert.match(messung, /AudioManager\.shared\.add\(localAudioRenderer: lokal\)/);
  assert.match(messung, /AudioManager\.shared\.remove\(remoteAudioRenderer: fern\)/);
  // Nie die Adresse eines Kandidaten, nur ihre Familie.
  assert.doesNotMatch(messung, /"[a-zA-Z]+": l\?\.address[,\n]/);
  const projekt = readFileSync(new URL('../../mobile/ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  assert.match(projekt, /SpracheRaumMessung\.swift in Sources \*\/,/);
});
