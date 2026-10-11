import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * iOS-Bughunt 2, F7: die Kamera-Erklärung blieb stehen, nachdem die
 * Kamera-Ansicht darunter abgebaut war (Android: die Zurück-Taste schliesst
 * die Ansicht, nicht das Blatt). Ein „Erlauben" öffnete danach Kamera und
 * Mikrofon ohne Ansicht. Am Quelltext geprüft — beide Dateien tragen Runes und
 * sind von Nodes Testläufer nicht ladbar (s. CLAUDE.md).
 */

const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');
const kamera = lies('lib/components/mobile/KameraOverlay.svelte');

test('der Abbau zieht die Erklärung zurück und entwertet den laufenden Start', () => {
  assert.match(kamera, /return \(\) => \{\s*untrack\(\(\) => \{[\s\S]*?lauf \+= 1;\s*berechtigungsblatt\.abbrechen\('kamera'\);/);
});

test('nach jedem await prüft der Start, ob seine Ansicht noch steht', () => {
  assert.match(kamera, /await berechtigungsblatt\.fragen\('kamera'[\s\S]*?if \(meinLauf !== lauf\) return;/);
  assert.match(kamera, /await navigator\.mediaDevices\.getUserMedia\([\s\S]*?if \(meinLauf !== lauf\) \{\s*neu\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\);/);
});

test('ein zurückgezogenes Blatt wird nicht als Antwort gemerkt', () => {
  const blatt = lies('lib/platform/berechtigung.svelte.ts');
  assert.match(blatt, /if \(zurueckgezogen\) return false;[\s\S]*?karteMerken\(ABGELEHNT_SCHLUESSEL/);
});
