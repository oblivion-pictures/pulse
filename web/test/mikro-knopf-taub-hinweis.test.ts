import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Meldung 21.11. (iOS-Handy): „ich kann mich nicht entstummen, bzw ich höre
 * niemanden über das Handy." Beides ist EIN Zustand: Die Taubstellung hält den
 * Ton der anderen auf 0 (Hülle: `SpracheRaumTaub.swift`) und das Mikrofon mit
 * zu — der Mikro-Knopf ist dabei aber nicht deaktiviert. `toggleMic` stieg
 * stumm aus: kein Toast, auf dem Handy kein Tooltip, der rote Knopf sah tot
 * aus, und nichts wies auf das Kopfhörer-Symbol als Ausgang. Der Hinweis muss
 * im selben Block wie das Verweigern stehen — sonst kommt der stumme Ausstieg
 * zurück.
 *
 * Quelltext-Test, weil `livekit.svelte.ts` Runen und `$lib`-Aliase zieht
 * (`pnpm test:unit`-Falle, gleiche Begründung wie
 * `voice-override-enttauben.test.ts`).
 */
const lies = (pfad: string) => readFileSync(new URL(`../${pfad}`, import.meta.url), 'utf8');

test('toggleMic sagt die Taubstellung, statt stumm zu weigern', () => {
  const raum = lies('src/lib/voice/livekit.svelte.ts');
  assert.match(
    raum,
    /if \(this\.deafened\) \{\s*\n\s*toast\.info\(m\.livekit_mikro_taub\(\)\);\s*\n\s*return;/
  );
});

test('der stumme Ausstieg bei Taubstellung darf nicht zurückkommen', () => {
  const raum = lies('src/lib/voice/livekit.svelte.ts');
  assert.doesNotMatch(raum, /if \(this\.deafened\) return;/);
});

test('der Hinweis existiert in beiden Sprachen', () => {
  for (const datei of ['messages/de.json', 'messages/en.json']) {
    const inhalt = lies(datei);
    assert.match(inhalt, /"livekit_mikro_taub": "/, `${datei} fehlt der Schlüssel`);
  }
});
