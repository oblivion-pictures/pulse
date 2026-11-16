import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Meldung 16.11.: Wer selbst taubgestellt war (Mikrofon + Ton aus) und von
 * der Moderation serverweit stumm- und wieder freigeschaltet wurde, endete
 * mit laufendem Mikrofon und Ton an — der `voice_override`-Handler verglich
 * den ADMIN-Deafen-Flag des Events mit dem LOKALEN `voice.deafened` und
 * rief `setDeafened(evt.deafened)`: jedes Admin-Mute (Event trägt
 * deafened=false) enttaubte Selbst-Getaubte, das Unmute stellte über den
 * mitgesicherten Mikrofon-Vorzustand auch noch das Mikrofon her.
 *
 * Quelltext-Test, weil `livekit.svelte.ts` Runen und `$lib`-Aliase zieht
 * (`pnpm test:unit`-Falle, gleiche Begründung wie
 * `sprachraum-carplay-mikro.test.ts`).
 */
const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');

test('applyForceDeafen wirkt nur bei einem Wechsel des Admin-Flags', () => {
  const raum = lies('lib/voice/livekit.svelte.ts');
  assert.match(
    raum,
    /applyForceDeafen\(deafened: boolean\): void \{\s*\n\s*if \(deafened === this\.#forceDeafened\) return;/
  );
});

test('ein Admin-Enttauben hebt eine eigene Taubstellung nicht auf', () => {
  const raum = lies('lib/voice/livekit.svelte.ts');
  // Beim Admin-Deafen merken, ob der Nutzer selbst taub war …
  assert.match(raum, /this\.#selfDeafenedBeforeForceDeafen = this\.deafened;/);
  // … und beim Enttauben nur ohne eigene Taubstellung zurücksetzen.
  assert.match(
    raum,
    /if \(!this\.#selfDeafenedBeforeForceDeafen\) this\.setDeafened\(false\);/
  );
});

test('der voice_override-Handler geht über applyForceDeafen, nicht über den Direktvergleich', () => {
  const handler = lies('lib/ws/handlers/voice.ts');
  assert.match(handler, /voice\.applyForceDeafen\(evt\.deafened\);/);
  // Der alte Fehlerweg darf nicht zurückkommen: Der Admin-Flag des Events
  // darf nie gegen die lokale Taubstellung des Nutzers verglichen werden.
  assert.doesNotMatch(handler, /evt\.deafened !== voice\.deafened/);
  // Deafen weiterhin VOR dem Mute (Bughunt Runde 25).
  const deafenPos = handler.indexOf('voice.applyForceDeafen(evt.deafened);');
  const mutePos = handler.indexOf('voice.applyForceMute(evt.muted);');
  assert.ok(deafenPos >= 0 && mutePos > deafenPos);
});

test('die Reconciliation nach Reconnect läuft über dieselben Wechsel-Hüter', () => {
  const raum = lies('lib/voice/livekit.svelte.ts');
  assert.match(
    raum,
    /applyOverrideReconciliation\(muted: boolean, deafened: boolean\): void \{\s*\n\s*this\.applyForceDeafen\(deafened\);\s*\n\s*this\.applyForceMute\(muted\);/
  );
});

test('der Teardown nimmt die neuen Merker mit zurück', () => {
  const raum = lies('lib/voice/livekit.svelte.ts');
  const teardown = raum.slice(raum.indexOf('#teardown'));
  assert.match(teardown, /this\.#forceDeafened = false;/);
  assert.match(teardown, /this\.#selfDeafenedBeforeForceDeafen = false;/);
});
