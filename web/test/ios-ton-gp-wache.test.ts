import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Funde der Gegenprüfung vom 2026-10-17 zu fix/ios-ton-sitzung (T1–T7). Die
// Hülle hat kein Swift-Testziel; was nur dort liegt, wird am Quelltext
// gehalten — so wie die übrigen Verträge zwischen Web und Hülle.

const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const swift = (f: string) => lesen(`../../mobile/ios/App/App/${f}`);

test('T1: Stufe 2 und 3 nur, wenn kein fremder Halter die Session hat', () => {
  const w = swift('SpracheMikroWache.swift');
  const regel = /static func eingreifenErlaubt\([\s\S]*?\n {4}\}/.exec(w)?.[0] ?? '';
  assert.match(regel, /guard vordergrund, !fremdTon else \{ return false \}/);
  assert.match(regel, /jetzt - seit >= unterbrechungsGeduld/);
  // Vor jeder Stufe ab 2 wird gefragt; Stufe 1 (nur Web) bleibt erlaubt.
  assert.match(w, /if stufe >= 1, !erlaubt \{/);
  // Eine gescheiterte Freigabe wird nachgeholt — auch nach `tot`.
  assert.match(w, /if maschineOffen, erlaubt, sprache\.raum != nil \{/);
  assert.match(swift('SpracheRaumSession.swift'), /didEnterBackgroundNotification[\s\S]*?vordergrund\(false\)/);
});

test('T1: Freigeben bleibt nie auf .none, „nur Ausgabe" nur ohne Erlaubnis', () => {
  const n = swift('SpracheRaumNeustart.swift');
  assert.match(n, /if let fehler = Self\.maschineFreigebenJetzt\(\) \{\s*try\? am\.setEngineAvailability\(vorher\)/);
  assert.match(n, /wache\.maschineStand\(frei: fehler == nil\)/);
  const jetzt = /static func maschineFreigebenJetzt\(\)[\s\S]*?\n {4}\}/.exec(n)?.[0] ?? '';
  assert.match(jetzt, /Anrufverwaltung\.mikrofonErlaubt\(\)\s*\? AudioEngineAvailability\.default/);
});
