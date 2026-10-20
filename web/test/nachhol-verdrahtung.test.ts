import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Verdrahtung des Nachholens im offenen Chat (Push-Bughunt, 2026-10-21,
 * „wenn ich einen Chat offen habe, kommen manchmal Nachrichten nicht an").
 * Quelltext-Test, weil die Module `$lib`-Aliase, Stores und Capacitor
 * nachziehen (`pnpm test:unit`-Falle in CLAUDE.md); die Rechnungen prüft
 * `nachhol-netz`.
 */
const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');

/** Rumpf eines `registerWsHandler('<op>', …)` bis zum nächsten Handler. */
function handler(quelle: string, op: string): string {
  const start = quelle.indexOf(`registerWsHandler('${op}'`);
  assert.ok(start >= 0, `Handler ${op} fehlt`);
  const ende = quelle.indexOf('registerWsHandler(', start + 1);
  return quelle.slice(start, ende < 0 ? undefined : ende);
}

test('Befund 1: Bump für einen offenen Kanal prüft, ob die Nachricht da ist', () => {
  const chat = lies('lib/ws/handlers/chat.ts');
  assert.match(
    handler(chat, 'channel_bump'),
    /if \(ctx\.subs\.has\(evt\.channel_id\)\) \{\s*readState\.markRead\(evt\.channel_id, evt\.message_id\);\s*bumpNachschauen\(evt\.channel_id, evt\.message_id\);/
  );
  assert.match(
    handler(chat, 'dm_bump'),
    /const offen = ctx\.subs\.has\(evt\.channel_id\);\s*if \(offen\) bumpNachschauen\(evt\.channel_id, evt\.message_id\);/
  );
  const netz = lies('lib/ws/handlers/nachholNetz.ts');
  assert.match(netz, /messages\.for\(kanalId\)\.some\(\(m\) => m\.id === nachrichtId\)/);
  assert.match(netz, /gapFillChannel\(kanalId, true, \{ serverId \}\)/);
});

test('Befund 2: Nachholen beim Neuaufbau erst hinter der Pong-Schranke', () => {
  const gw = lies('lib/ws/gateway-connection.ts');
  const hello = gw.slice(gw.indexOf("if (op === 'hello')"), gw.indexOf('return; // Hello selbst'));
  assert.doesNotMatch(hello, /(?<!=> )void gapFillAll\(/, 'kein REST-Nachholen direkt beim hello');
  assert.equal((hello.match(/this\._nachAbos\(\(\) => void gapFillAll\(/g) ?? []).length, 2);
  // Jeder Ping wird gezählt, jeder Pong löst die Schranke.
  assert.match(gw, /if \(evt\.op === 'ping'\) this\._schranke\.gesendet\(\);/);
  assert.match(gw, /this\.lastPongAt = Date\.now\(\);\s*this\._schranke\.empfangen\(\);/);
  assert.match(gw, /private _nachAbos\(fn: \(\) => void\): void \{\s*if \(this\._sendRaw\(\{ op: 'ping' \}\)\) this\._schranke\.nach\(fn\);/);
});

test('Befund 3: ein Abo-Fehlerrahmen führt zur Wiederholung, danach Nachholen', () => {
  const gw = lies('lib/ws/gateway-connection.ts');
  assert.match(gw, /if \(op === 'error'\) this\._aboFehlerPruefen\(evt\);/);
  assert.match(gw, /this\._aboWiederholung\.fehler\(f\.channel_id, f\.code\);/);
  assert.match(
    gw,
    /if \(this\._aboWiederholung\.bestaetigt\(cid, versuch\)\) void this\.gapFill\(cid\);/
  );
  // Abbestellen, Abbau und Abmelden räumen die geplanten Runden ab.
  assert.match(gw, /if \(!this\.subs\.delete\(channelId\)\) return;\s*this\._aboWiederholung\.vergessen\(channelId\);/);
  assert.match(gw, /this\._schranke\.zuruecksetzen\(\);\s*this\._aboWiederholung\.alleVergessen\(\);/);
  assert.match(lies('lib/ws/handlers/types.ts'), /op: 'error'; code: number; msg: string; ref_op\?: string; channel_id\?: string/);
});

test('Befund 5: wieder vorn ⇒ Postfach über den Anzeige-Weg und Kanäle nachholen', () => {
  const layout = lies('routes/app/+layout.svelte');
  assert.match(
    layout,
    /beiVordergrund\(\(\) => \{\s*hintergrundZyklusStoppen\(\);(\s*\/\/[^\n]*)*\s*postfachAbholenAusDerApp\(\);\s*gatewayPool\.alleNachholen\(\);\s*\}\);/
  );
  assert.match(lies('lib/ws/gateway-pool.svelte.ts'), /alleNachholen\(\): void \{\s*for \(const conn of this\.#connections\.values\(\)\) conn\.nachholen\(\);/);
  assert.match(lies('lib/ws/gateway-connection.ts'), /nachholen\(\): void \{\s*if \(!this\._readyDone \|\| this\.state !== 'open'\) return;/);
});

test('Befund 6: ein gescheiterter Postfach-Zyklus wird wiederholt, ein Erfolg setzt zurück', () => {
  const chat = lies('lib/ws/handlers/chat.ts');
  assert.match(chat, /postfachWiederholung\.erfolgreich\(\);/);
  assert.match(chat, /if \(!stumm\) postfachWiederholung\.fehlgeschlagen\(\);/);
  // Die Wiederholung nimmt denselben Anzeige-Weg.
  assert.match(
    chat,
    /const postfachWiederholung = postfachWiederholerErzeugen\(\(\) => postfachAbholenAusDerApp\(\)\);/
  );
});
