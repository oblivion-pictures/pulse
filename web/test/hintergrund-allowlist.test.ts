/**
 * Die Hintergrund-Allowlist der Cloud-Verbindung (`ws/dispatch-rules.ts`)
 * muss jedes Ereignis tragen, das NUR die Cloud schickt und auch bei aktivem
 * Self-Host ankommen muss.
 *
 * Die Fehlerklasse ist belegt: `postfach_neu` fehlte bis 2026-09-03, und eine
 * verschlüsselte DM erschien bei aktivem Self-Host erst nach einem Reload —
 * kein Test im Gate sah es (intern/docs/wissen/e2e-krypto.md, ehemals CLAUDE.md, Abschnitt E2E-DMs). Seit 2026-10 kommt
 * `instanz_verbunden` dazu: fehlt es, erscheint ein frisch verbundener Server
 * auf einem Gerät mit aktivem Self-Host erst nach einer Neuanmeldung.
 *
 * Warum die Quelle gelesen wird statt `backgroundEligible` aufzurufen:
 * `dispatch-rules.ts` importiert Svelte-Stores, Nodes Testläufer stirbt daran
 * (`$state is not defined`, s. `pnpm test:unit`-Falle in CLAUDE.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Quelltext ohne Kommentare — ein Op-Name im Kommentar zählt nicht. */
function quelle(pfad: string): string {
  return readFileSync(new URL(pfad, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function opsImHintergrund(): Set<string> {
  const code = quelle('../src/lib/ws/dispatch-rules.ts');
  const block = code.match(/const PURE_SOCIAL_OPS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'PURE_SOCIAL_OPS in ws/dispatch-rules.ts nicht gefunden');
  return new Set([...block[1].matchAll(/'([a-z_]+)'/g)].map((t) => t[1]));
}

test('die Gegenprobe: der Leser findet die bekannten Einträge', () => {
  // Ein Leser, der nichts findet, machte den nächsten Test immer rot — oder,
  // bei leerer Handler-Liste, immer grün. Diese Einträge stehen seit Monaten.
  const ops = opsImHintergrund();
  for (const op of ['friend_request_received', 'postfach_neu', 'instance_status']) {
    assert.ok(ops.has(op), op);
  }
});

test('jedes Ereignis aus handlers/instanzen.ts darf im Hintergrund durch', () => {
  // instanzen.ts nimmt nur Cloud-Ereignisse an (`dispatchingIsCloud()`), und
  // bei aktivem Self-Host läuft genau diese Verbindung im Hintergrund.
  const handler = quelle('../src/lib/ws/handlers/instanzen.ts');
  const registriert = [...handler.matchAll(/registerWsHandler\(\s*'([a-z_]+)'/g)].map((t) => t[1]);
  assert.ok(registriert.includes('instanz_verbunden'), 'instanz_verbunden fehlt in instanzen.ts');
  const ops = opsImHintergrund();
  for (const op of registriert) {
    assert.ok(ops.has(op), `${op} fehlt in PURE_SOCIAL_OPS (ws/dispatch-rules.ts)`);
  }
});
