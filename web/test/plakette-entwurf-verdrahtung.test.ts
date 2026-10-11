import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Verdrahtung aus dem iOS-Bughunt 2 (C1, C6, C7), am Quelltext geprüft: die
 * Dateien ziehen `$lib`-Aliase und Runes nach und sind von Nodes Testläufer
 * nicht ladbar (s. `pnpm test:unit`-Falle in CLAUDE.md). Die Regeln selbst
 * stehen geprüft in `badgeDrossel.test.ts`.
 */

const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');

test('C7: das Icon bekommt die Zahl erst, wenn sie etwas bedeutet', () => {
  const layout = lies('routes/app/+layout.svelte');
  assert.doesNotMatch(layout, /badgeSetzen\(/, 'die Oberfläche setzt das Icon nicht mehr selbst');
  const melden = lies('lib/platform/badgeMelden.ts');
  const rumpf = melden.match(/export function badgeMelden\(wert: number\): void \{[\s\S]*?\n\}/);
  assert.ok(rumpf);
  assert.match(rumpf[0], /if \(stand\.bereit\) \{[\s\S]*?badgeSetzen\(wert\)/);
});

test('C1: eine Zustellung bei wacher App meldet den Stand nach dem Abholen neu', () => {
  const chat = lies('lib/ws/handlers/chat.ts');
  assert.match(
    chat,
    /registerWsHandler\('postfach_neu', \(\) => \{[\s\S]*?badgeNachZustellung\(\);[\s\S]*?postfachAbholenUndAnzeigen\(/
  );
});

test('C6: eine nicht gesendete Banner-Antwort erscheint auch im offenen Gespräch', () => {
  const seite = lies('routes/app/@me/[[dmChannelId]]/+page.svelte');
  assert.equal((seite.match(/drafts\.einsetzen\(id, text\)/g) ?? []).length, 2);
  assert.doesNotMatch(seite, /drafts\.set\(id, text\)/);
  // Das Eingabefeld liest den Entwurf neu, wenn von aussen eingesetzt wurde.
  const eingabe = lies('lib/components/MessageInput.svelte');
  assert.match(eingabe, /drafts\.einsetzungen\(id\);\s*text = id \? untrack\(\(\) => drafts\.get\(id\)\)/);
});
