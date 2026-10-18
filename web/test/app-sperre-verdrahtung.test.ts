import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * iOS-Bughunt 2 vom 2026-10-11 (F1, F5) — die App-Sperre deckt wirklich,
 * und eine Antwort aus dem Mitteilungs-Banner wartet auf die Entsperrung.
 * Was beim Start auf sie wartet (F4), prüft `start-beitritt-verdrahtung.test.ts`.
 * Als Text gelesen, weil Svelte-Dateien und Runes im Node-Läufer nicht laufen
 * (dasselbe Muster wie `anruf-sperrbildschirm-verdrahtung.test.ts`).
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lies = (pfad: string) => readFileSync(join(webRoot, pfad), 'utf8');
const vor = (text: string, a: string, b: string) => {
  const i = text.indexOf(a);
  const j = text.indexOf(b);
  assert.ok(i >= 0, `fehlt: ${a}`);
  assert.ok(j >= 0, `fehlt: ${b}`);
  assert.ok(i < j, `${a} muss vor ${b} stehen`);
};

test('F5: die Banner-Antwort geht erst nach der Entsperrung hinaus', () => {
  const dm = lies('src/routes/app/@me/[[dmChannelId]]/+page.svelte');
  vor(dm, 'if (appSperre.gesperrt) return;', 'bannerAntworten.nehmen(id)');
});

test('F1: die Sperrfläche deckt, liegt über den Toasts und legt den Rest still', () => {
  const sperre = lies('src/lib/components/AppSperre.svelte');
  assert.match(sperre, /background: var\(--bg-grad\)/);
  assert.doesNotMatch(sperre, /class="bg-bg-base/, 'bg-bg-base ist transparent');
  const z = Number(/z-index: (\d+)/.exec(sperre)?.[1]);
  assert.ok(z > 999999999, 'über svelte-sonner');
  assert.match(sperre, /restlicheAppSperren\(wurzel\)/);
  assert.match(sperre, /html\[data-app-sperre\] \[data-sonner-toaster\]/);
});

test('B1: kein_code hebt die Sperre NICHT auf — Hinweis und Abmelden sind der Ausweg', () => {
  const sperre = lies('src/lib/components/AppSperre.svelte');
  assert.match(sperre, /data-testid="app-sperre-abmelden"/);
  assert.match(sperre, /appSperre\.abmeldenUndAufheben\(abmelden\)/);
  assert.match(sperre, /\{#if appSperre\.keinCode\}[\s\S]*appsperre_kein_code_hinweis/);
  const store = lies('src/lib/platform/appSperre.svelte.ts');
  // Abmelden räumt die Einstellung ab und hebt die Sperre auf.
  assert.match(store, /abmeldenUndAufheben\(abmelden: \(\) => Promise<void>\): Promise<void> \{\s*try \{\s*await abmelden\(\);\s*\} finally \{\s*sperreSetzen\(false\);\s*this\.#aufheben\(\);/);
  // kein_code: Merker setzen, NICHT aufheben (fail-closed).
  const zweig = /ausgang === 'kein_code'\) \{([\s\S]*?)\n      \}/.exec(store)?.[1] ?? '';
  assert.match(zweig, /this\.keinCode = true;/);
  assert.doesNotMatch(zweig, /#aufheben|sperreSetzen/);
});
