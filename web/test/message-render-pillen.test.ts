import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Security-Scan 2026-10-24 (Nieder): Mention-Pillen-Spoofing. Die Render-
 * Pipeline (marked + DOMPurify) ließ `span` und `class` aus Rohtexten durch —
 * jedes Mitglied konnte `<span class="mention mention--self">@Admin</span>`
 * posten und native Pillen fälschen (CSS formt Pillen NUR über die Klassen,
 * app.css:607ff; data-Attribute sind reine Test-Haken).
 *
 * `renderMessage` selbst ist in Node nicht lauffähig (DOMPurify braucht ein
 * DOM, die Stores sind `.svelte.ts`-Module) — deshalb hält dieser Test die
 * VERDRAHTUNG fest, das Muster von `mention-markierungen.test.ts`:
 * 1. `class` darf nicht in ALLOWED_ATTR stehen (rohe Klassen fliegen raus).
 * 2. Der Pille-Hook ERZEUGT seine Spans selbst und setzt die Klassen DIREKT
 *    (afterSanitizeAttributes läuft nach der Attribut-Filterung — die
 *    hook-eigenen Klassen überleben; nur so gibt es echte Pillen weiter).
 * 3. `span` bleibt als Tag erlaubt (unschuldiges Inline-Markup bleibt Text,
 *    nur eben klassenlos).
 */

const quelldatei = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/lib/components/messageRender.ts'
);
const quelltext = readFileSync(quelldatei, 'utf8');

function arrayLiteral(name: string): string[] {
  const treffer = quelltext.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
  assert.ok(treffer, `${name} existiert als Array-Literal in messageRender.ts`);
  return (treffer![1].match(/'[^']+'/g) ?? []).map((s) => s.slice(1, -1));
}

test('ALLOWED_ATTR enthält kein class — rohe HTML-Klassen erreichen den DOM nie', () => {
  const attr = arrayLiteral('ALLOWED_ATTR');
  assert.ok(!attr.includes('class'), `class ist durchgelassen: ${attr.join(', ')}`);
});

test('Pille-Hook erzeugt eigene Spans und setzt die Klassen selbst', () => {
  assert.match(quelltext, /createElement\('span'\)/, 'Hook baut eigene Spans');
  assert.match(quelltext, /cls\.push\('mention/, 'Hook setzt die mention-Klassen');
  assert.match(
    quelltext,
    /span\.className = cls\.join\(' '\)/,
    'Klassen werden am Span zugewiesen, nicht aus Rohtext durchgereicht'
  );
});

test('span bleibt als erlaubtes Tag — Inline-Markup bleibt Text, nur klassenlos', () => {
  const tags = arrayLiteral('ALLOWED_TAGS');
  assert.ok(tags.includes('span'));
});
