import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * CarPlay-Befund vom 2026-10-25: das Mikrofon scheiterte beim Beitritt, die
 * Hülle holt es nach (`SpracheRaumMikroNachholen.swift`). Die Oberfläche muss
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
    /if \(e\.mikrofonFehler === null && w\.error === m\.livekit_microphone_access_failed\(\)\) \{\s*w\.error = null;/
  );
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
