import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Der Sprachkanal als Systemanruf (CallKit) auf iOS — Schalter, Vorgabe aus
 * (`SpracheSystemanruf.swift`, `SpracheSystemanrufSession.swift`).
 *
 * Quelltext-Tests nach dem Muster von `sprachraum-carplay-mikro.test.ts`: Für
 * Swift gibt es auf dieser Maschine keinen Compiler, und die Runen-Dateien
 * des Web lädt der Läufer nicht. Festgeschrieben sind die Vereinbarungen, an
 * denen der Weg hängt: Die 1:1-Anrufe bleiben unberührt, der Kanal weicht,
 * der Wächter sieht den eigenen Anruf nicht als Telefonat.
 */
const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');
const huelle = (pfad: string) =>
  readFileSync(new URL(`../../mobile/ios/App/App/${pfad}`, import.meta.url), 'utf8');
const SYSTEMANRUF_DATEIEN = ['SpracheSystemanruf.swift', 'SpracheSystemanrufSession.swift'];

/** Der Code ohne Kommentare und Zeichenketten — für die Klammerzählung. */
function code(text: string): string {
  let aus = '';
  for (let i = 0; i < text.length; ) {
    if (text.startsWith('//', i)) {
      const ende = text.indexOf('\n', i);
      i = ende < 0 ? text.length : ende;
    } else if (text.startsWith('/*', i)) {
      let tiefe = 1;
      i += 2;
      while (i < text.length && tiefe > 0) {
        if (text.startsWith('/*', i)) {
          tiefe += 1;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          tiefe -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      aus += ' ';
    } else if (text[i] === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
        i += text[i] === '\\' ? 2 : 1;
      }
      // Sauber geschlossen: zwei Anführungszeichen. Von Zeilenende oder
      // Dateiende abgeschnitten: eins — die Zählung wird dann ungerade.
      aus += i < text.length && text[i] === '"' ? '""' : '"';
      i += 1;
    } else {
      aus += text[i];
      i += 1;
    }
  }
  return aus;
}

test('beide Dateien sind im Xcode-Projekt eingetragen', () => {
  const projekt = readFileSync(
    new URL('../../mobile/ios/App/App.xcodeproj/project.pbxproj', import.meta.url),
    'utf8'
  );
  for (const datei of SYSTEMANRUF_DATEIEN) {
    // Eintrag in den Quellen des App-Targets …
    assert.match(projekt, new RegExp(`${datei} in Sources \\*/,$`, 'm'));
    // … und die Datei, auf die er zeigt.
    assert.match(projekt, new RegExp(`path = ${datei}; sourceTree = "<group>";`));
  }
});

test('in beiden Dateien schließt jede Klammer', () => {
  for (const datei of SYSTEMANRUF_DATEIEN) {
    const c = code(huelle(datei));
    assert.equal((c.match(/\(/g) ?? []).length, (c.match(/\)/g) ?? []).length, datei);
    assert.equal((c.match(/\[/g) ?? []).length, (c.match(/\]/g) ?? []).length, datei);
    assert.equal((c.match(/\{/g) ?? []).length, (c.match(/\}/g) ?? []).length, datei);
    assert.equal((c.match(/"/g) ?? []).length % 2, 0, `${datei}: Zeichenkette offen`);
  }
});

test('die Klammerzählung der Prüfung findet einen offenen Fehler', () => {
  // Gegenprobe: sonst wiese eine grüne Prüfung nichts nach. Klammern in
  // Zeichenketten und Kommentaren zählen nicht …
  assert.equal(code('let a = "("').includes('('), false);
  assert.equal((code('a( // )(\n').match(/\)/g) ?? []).length, 0);
  assert.equal((code('a( /* } */ {').match(/\}/g) ?? []).length, 0);
  assert.equal((code('f("x") {').match(/\(/g) ?? []).length, 1);
  // … eine abgeschnittene Zeichenkette macht die Zählung ungerade.
  assert.equal((code('f("x').match(/"/g) ?? []).length % 2, 1);
});

test('beide Dateien halten die Größen-Policy (höchstens 350 Zeilen)', () => {
  for (const datei of SYSTEMANRUF_DATEIEN) {
    const zeilen = huelle(datei).trimEnd().split('\n').length;
    assert.ok(zeilen <= 350, `${datei}: ${zeilen} Zeilen`);
  }
});

test('der Schalter ist sein eigenes Kennzeichen, kein Teil des nativen Wegs', () => {
  const typen = lies('lib/platform/iosSpracheTypen.ts');
  assert.match(typen, /export const SPRACHE_SYSTEMANRUF_METHODEN: readonly string\[\] = \['systemanruf'\];/);
  assert.match(typen, /systemanruf\(o: \{ an: boolean \}\): Promise<void>;/);
  // Sonst gälte jeder Bau vor dem Systemanruf als veraltet.
  const nativerWeg = typen.slice(typen.indexOf('export const SPRACHE_METHODEN'));
  assert.ok(!nativerWeg.includes('systemanruf'));
  const weiche = lies('lib/platform/iosSpracheWeiche.ts');
  assert.match(weiche, /export function nativeSystemanrufDa\(\): boolean \{/);
});

test('Web und Hülle sprechen dieselbe Methode', () => {
  const plugin = huelle('SprachePlugin.swift');
  assert.match(plugin, /CAPPluginMethod\(name: "systemanruf", returnType: CAPPluginReturnPromise\)/);
  assert.match(plugin, /@objc func systemanruf\(_ call: CAPPluginCall\)/);
  assert.match(plugin, /wunschSetzen\(call\.getBool\("an"\) \?\? false, grund: "wunsch"\)/);
  const web = lies('lib/platform/iosSystemanruf.ts');
  assert.match(web, /\?\.systemanruf\(\{ an \}\)/);
  assert.match(web, /if \(!nativeSystemanrufDa\(\)\) return;/);
});

test('der Schalter geht über den Setter: beim Umlegen und beim Start', () => {
  const ui = lies('lib/components/settings/IosTonEinstellungen.svelte');
  assert.match(ui, /const systemanrufAnbieten = ios && nativeSystemanrufDa\(\);/);
  assert.match(ui, /\{#if systemanrufAnbieten\}/);
  assert.match(ui, /settings\.setIosSystemanruf\(v\);\s*systemanrufSetzen\(v\);/);
  const layout = lies('routes/app/+layout.svelte');
  assert.match(layout, /systemanrufSetzen\(settings\.audio\.iosSystemanruf\);/);
});

test('die Texte stehen in beiden Sprachen', () => {
  for (const sprache of ['de', 'en']) {
    const meldungen = readFileSync(
      new URL(`../messages/${sprache}.json`, import.meta.url),
      'utf8'
    );
    assert.match(meldungen, /"settings_audio_ios_systemanruf_label": ".+"/);
    assert.match(meldungen, /"settings_audio_ios_systemanruf_hint": ".+"/);
  }
});

test('die neuen Dateien setzen den CallKit-Schalter der 1:1-Anrufe nie', () => {
  // `callkitAktiv` heißt dort „ein 1:1-Anruf läuft"; Lesen dürfen die neuen
  // Dateien ihn, setzen nicht.
  for (const datei of SYSTEMANRUF_DATEIEN) {
    assert.doesNotMatch(huelle(datei), /callkitAktiv\s*=[^=]/, datei);
  }
});

test('der Kanal weicht, bevor ein 1:1-Anruf CallKit bekommt', () => {
  // Eingehend: der einzige Weg zu `reportNewIncomingCall`.
  const push = huelle('AnrufPush.swift');
  const weichen = push.indexOf('SpracheSystemanruf.geteilt.weichen(grund: "melden")');
  const melden = push.indexOf('anbieter.reportNewIncomingCall(');
  assert.ok(weichen > 0, 'weichen fehlt in AnrufPush.swift');
  assert.ok(weichen < melden, 'weichen muss vor dem Melden stehen');
  // Gehend und in der App angenommen: der einzige Weg zum Start eines
  // 1:1-Anrufs.
  const callKit = huelle('AnrufCallKit.swift');
  const beginn = callKit.indexOf('SpracheSystemanruf.geteilt.weichen(grund: "beginnen")');
  const uuid = callKit.lastIndexOf('let uuid = UUID()');
  assert.ok(beginn > 0, 'weichen fehlt in AnrufCallKit.swift');
  assert.ok(beginn < uuid, 'weichen muss vor dem Start des Gesprächs stehen');
});

test('die Delegat-Aktionen verteilen nach UUID', () => {
  const callKit = huelle('AnrufCallKit.swift');
  for (const aufruf of [
    'SpracheSystemanruf.geteilt.startAusgefuehrt(provider, action)',
    'SpracheSystemanruf.geteilt.vomSystemBeendet(action)',
    'SpracheSystemanruf.geteilt.stumm(action)',
    'if SpracheSystemanruf.geteilt.aktiviert() { return }',
    'if SpracheSystemanruf.geteilt.deaktiviert() { return }',
    'SpracheSystemanruf.geteilt.zurueckgesetzt()'
  ]) {
    assert.ok(callKit.includes(aufruf), `fehlt: ${aufruf}`);
  }
});

test('der Beitritt geht über den Vorlauf; das Vorwärmen nur ohne Systemanruf', () => {
  const raum = huelle('SpracheRaum.swift');
  assert.match(raum, /let vorlauf = await SpracheSystemanruf\.geteilt\.beitrittVorlauf\(/);
  assert.match(raum, /"systemanruf": vorlauf\.systemanruf/);
  assert.doesNotMatch(raum, /let vorgewaermt = await carPlayVorwaermen\(\)/);
  const system = huelle('SpracheSystemanruf.swift');
  assert.match(system, /return \(false, await SpracheRaum\.geteilt\.carPlayVorwaermen\(\)\)/);
  assert.match(system, /return \(true, false\)/);
});

test('der Kanal tritt zurück, und ein Beitritt beendet erst den vorigen Anruf', () => {
  const system = huelle('SpracheSystemanruf.swift');
  // Kein Systemanruf neben einem 1:1-Anruf — auch keinem klingelnden.
  assert.match(system, /return !v\.callkitAktiv && !v\.ohneCallKit && v\.kennungen\.isEmpty/);
  assert.match(system, /if fuehrt \{ await MainActor\.run \{ self\.weichen\(grund: "beitritt"\) \} \}/);
  const sitzung = huelle('SpracheSystemanrufSession.swift');
  assert.match(sitzung, /func weichen\(grund: String\) \{ beenden\(grund: "weichen_" \+ grund\) \}/);
});

test('scheitert der Start, läuft der Kanal ohne Systemanruf weiter', () => {
  const system = huelle('SpracheSystemanruf.swift');
  assert.match(system, /static let aktivierungsFrist: TimeInterval = 3/);
  const fehlgeschlagen = system.slice(
    system.indexOf('private func fehlgeschlagen('),
    system.indexOf('// MARK: - Was das System meldet')
  );
  assert.match(fehlgeschlagen, /Self\.zurueckgeben\(\)/);
  assert.match(fehlgeschlagen, /fort\.resume\(returning: false\)/);
});

test('der Wächter hält den eigenen Anruf nicht für ein Telefonat', () => {
  const wache = huelle('SpracheMikroWache.swift');
  assert.match(wache, /anrufe\.calls\.contains \{ !\$0\.hasEnded && \$0\.uuid != eigen \}/);
  assert.match(wache, /guard !v\.callkitAktiv, !v\.ohneCallKit, !SpracheSystemanruf\.geteilt\.fuehrt,/);
});

test('die Heilwege fassen die Session nicht an, solange der Systemanruf führt', () => {
  const neustart = huelle('SpracheRaumNeustart.swift');
  const wache = /guard !v\.callkitAktiv, !v\.ohneCallKit, !SpracheSystemanruf\.geteilt\.fuehrt else \{ return nil \}/g;
  assert.equal([...neustart.matchAll(wache)].length, 2, 'maschineNeu und maschineFreigeben');
  // Die Wartezeit auf die Rückgabe steht einmal, beim Systemanruf.
  assert.match(neustart, /await SpracheSystemanruf\.geteilt\.rueckgabeAbwarten\(\)/);
});

test('Kategorie und Maschine stellt die Anruf-Verwaltung, für beide Wege', () => {
  // Keine zweite Abschrift: `private` gilt in Swift je Datei, deshalb sind
  // die zwei Helfer dort intern statt privat.
  const anruf = huelle('AnrufSitzung.swift');
  assert.match(anruf, /\n {4}func kategorieSetzen\(\) \{/);
  assert.match(anruf, /\n {4}func maschineStellen\(_ stand: AudioEngineAvailability, _ was: String\) \{/);
  const sitzung = huelle('SpracheSystemanrufSession.swift');
  assert.match(sitzung, /Anrufverwaltung\.geteilt\.maschineStellen\(ziel, "freigeben"\)/);
  assert.match(sitzung, /Anrufverwaltung\.geteilt\.maschineStellen\(\.none, "anhalten"\)/);
  for (const datei of SYSTEMANRUF_DATEIEN) {
    assert.doesNotMatch(huelle(datei), /func kategorieSetzen\(\)|func maschineStellen\(/, datei);
  }
});

test('nach der Rückgabe an das SDK gleicht der Bluetooth-Weg neu ab', () => {
  // Die Übernahme hatte ihn losgelassen; ohne den Anstoß bliebe er weg, wenn
  // der Systemanruf endet und der Kanal weiterläuft.
  const sitzung = huelle('SpracheSystemanrufSession.swift');
  const zurueck = sitzung.slice(sitzung.indexOf('static func zurueckgeben() {'));
  assert.match(zurueck, /SpracheRaum\.geteilt\.funkHqAnstossen\("systemanruf"\)/);
});

test('„Beenden" im System-Bildschirm nimmt den Weg des Live-Activity-Knopfes', () => {
  // Die Reihenfolge der Meldungen ist tragend (dort begründet) — eine Fassung.
  assert.match(
    huelle('SpracheSystemanruf.swift'),
    /Task \{ await SpracheRaum\.geteilt\.auflegenVonAussen\(\) \}/
  );
  const knoepfe = huelle('SpracheLiveAktivitaetKnoepfe.swift');
  assert.match(knoepfe, /\n {4}func auflegenVonAussen\(\) async \{/);
  assert.ok(!knoepfe.includes('private func verlassenAusAktivitaet'));
});

test('das Aufräumen darf die Raum-Felder setzen, obwohl es in eigener Datei steht', () => {
  // `private(set)` gilt in Swift je Datei — mit ihm wäre der Bau rot.
  const raum = huelle('SpracheRaum.swift');
  assert.match(raum, /\n {4}var raum: Room\?/);
  assert.match(raum, /\n {4}var kanalId: String\?/);
  assert.match(raum, /\n {4}var kanalName: String = ""/);
  assert.doesNotMatch(raum, /private\(set\) var (raum|kanalId|kanalName)\b/);
});

test('das Aufräumen des Raums beendet den Systemanruf', () => {
  const sitzung = huelle('SpracheRaumSession.swift');
  const loesen = sitzung.slice(sitzung.indexOf('func raumLoesen(_ r: Room) {'));
  assert.match(loesen, /SpracheSystemanruf\.geteilt\.beenden\(grund: "raum_weg"\)/);
  // Die Funktion steht nur noch einmal — wo sie hingezogen ist.
  assert.ok(!huelle('SpracheRaum.swift').includes('func raumLoesen('));
});
