import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Der Begrenzer am Ende der Wiedergabe reist als FELD am Brückenbefehl
// `lautstaerken`, nicht als eigene Methode (Begründung an `lautstaerken` in
// SprachePlugin.swift: eine neue Methode würfe jeden älteren App-Bau über die
// Weiche auf den Web-Weg zurück). Ein Feld hat dafür einen Preis: liest die
// Hülle es unter einem anderen Namen, als das Web es schickt, geschieht
// nichts, und nichts meldet es. Deshalb hier beide Seiten am Quelltext.

function quelle(pfad: string): string {
  return readFileSync(new URL(pfad, import.meta.url), 'utf8');
}

test('Web schickt `limiter`, die Hülle liest `limiter`', () => {
  const web = quelle('../src/lib/platform/iosSprache.ts');
  assert.match(web, /p\.lautstaerken\(\{[^}]*\blimiter: w\.limiter\b[^}]*\}\)/);
  const swift = quelle('../../mobile/ios/App/App/SprachePlugin.swift');
  const methode = /@objc func lautstaerken\(_ call: CAPPluginCall\) \{([\s\S]*?)\n {4}\}/.exec(swift)?.[1];
  assert.ok(methode, 'lautstaerken in SprachePlugin.swift nicht gefunden');
  assert.match(methode, /call\.getBool\("limiter"\)/);
});

test('der Wunsch liest die Einstellung, die die Oberfläche anbietet', () => {
  const befehle = quelle('../src/lib/voice/nativeBefehle.ts');
  assert.match(befehle, /limiter: settings\.audio\.limiterEnabled/);
});
