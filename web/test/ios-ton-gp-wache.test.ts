import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Mikrofon-Wächter der Hülle: Gegenprüfung T1 und Gegenprüfung 2 (U1–U5). Die
// Hülle hat kein Swift-Testziel; die Regeln stehen deshalb rein und an einer
// Stelle (`SpracheMikroWacheRegeln.swift`) und werden hier am Quelltext
// gehalten — so wie die übrigen Verträge zwischen Web und Hülle.

const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const swift = (f: string) => lesen(`../../mobile/ios/App/App/${f}`);
const regeln = swift('SpracheMikroWacheRegeln.swift');
const wache = swift('SpracheMikroWache.swift');

function funktion(quelle: string, kopf: string): string {
  const i = quelle.indexOf(kopf);
  assert.ok(i >= 0, `${kopf} fehlt`);
  const ende = quelle.indexOf('\n    }\n', i);
  return quelle.slice(i, ende);
}

test('T1/U2/U3: die Stufen-Regel', () => {
  const r = funktion(regeln, 'static func stufeErlaubt(');
  assert.match(r, /if stufe <= 1 \{ return true \}/, 'Stufe 1 immer');
  assert.match(r, /if fremdTon \{ return false \}/, 'nie gegen fremden Ton');
  // Im Hintergrund ohne Fremdes erlaubt: `vordergrund` zählt nur bei offener Unterbrechung.
  assert.match(r, /guard let seit = unterbrochenSeit else \{ return true \}/);
  assert.match(r, /return stufe == 2 && vordergrund && jetzt - seit >= unterbrechungsGeduld/);
  assert.match(regeln, /static let unterbrechungsGeduld: CFAbsoluteTime = 60/);
  assert.match(wache, /if !stufeErlaubt\(stufe \+ 1, jetzt\) \{/);
});

test('U1: der Vordergrund-Merker hängt nie', () => {
  const s = swift('SpracheRaumSession.swift');
  assert.match(s, /guard let self else \{ return \}\n[\s\S]{0,200}wache\.vordergrund\(true\)\n\s+if raum != nil \{ wache\.anstossen/);
  assert.match(swift('SpracheRaum.swift'), /applicationState != \.background \}\n\s+wache\.beginnen\(vordergrund: vorn\)/);
});

test('U4: Nachholen mit Rückzug, nicht im Telefonat, nur der erste Fehlschlag gemeldet', () => {
  assert.match(funktion(regeln, 'static func naechsterNachholAbstand('), /min\(nachholHoechstens, max\(nachholStart, a \* 2\)\)/);
  assert.match(regeln, /nachholHoechstens: TimeInterval = 30/);
  const n = funktion(wache, 'private func nachholenFallsNoetig(');
  assert.match(n, /!telefonatLaeuft\(\), stufeErlaubt\(2, jetzt\)/);
  assert.match(n, /let melden = !nachholFehlerGemeldet/);
  assert.match(n, /nachholenAb = CFAbsoluteTimeGetCurrent\(\) \+ nachholAbstand/);
});

test('U5: nachgeholt wird nach dem wahren Stand, nicht nach einem Merker', () => {
  const n = funktion(wache, 'private func nachholenFallsNoetig(');
  assert.match(n, /WacheRegeln\.maschineGesperrt\(AudioManager\.shared\.engineAvailability/);
  assert.doesNotMatch(wache, /maschineOffen/);
  const g = funktion(regeln, 'static func maschineGesperrt(');
  assert.match(g, /!a\.isOutputAvailable \|\| \(erlaubt && !a\.isInputAvailable\)/);
});

test('„nur Ausgabe" allein ohne Mikrofon-Erlaubnis', () => {
  const n = swift('SpracheRaumNeustart.swift');
  const jetzt = funktion(n, 'static func maschineFreigebenJetzt()');
  assert.match(jetzt, /Anrufverwaltung\.mikrofonErlaubt\(\)\s*\? AudioEngineAvailability\.default/);
});
