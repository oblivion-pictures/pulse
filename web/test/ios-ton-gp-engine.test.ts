import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Funde der Gegenprüfung vom 2026-10-17 zu fix/ios-ton-sitzung (T1–T7). Die
// Hülle hat kein Swift-Testziel; was nur dort liegt, wird am Quelltext
// gehalten — so wie die übrigen Verträge zwischen Web und Hülle.

const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const swift = (f: string) => lesen(`../../mobile/ios/App/App/${f}`);

test('T3: ersetzte Gilden-Töne werden auf iOS vergessen', () => {
  const g = lesen('../src/lib/ws/handlers/guild.ts');
  assert.match(g, /if \(alt && isIosWebKit\(\)\) sounds\.invalidateUrl\(alt\);\s*void guildSounds\.refresh/);
});

test('T5: entsperrt wird auf echten Gesten, abgemeldet erst nach Erfolg', () => {
  const e = lesen('../src/lib/sounds/engine.ts');
  assert.match(e, /const GESTEN = \['touchend', 'click', 'keydown'\] as const;/);
  assert.match(e, /if \(!frei\) return;\s*for \(const art of GESTEN\) document\.removeEventListener/);
});
