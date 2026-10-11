import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ohneRaumPlan } from '../src/lib/anrufe/ohneRaumPlan.ts';

/**
 * iOS-Bughunt 2 vom 2026-10-11, die Web-Seite der Anrufe: A4 (Annahme vom
 * Ende überholt), A6 (Quittung des Endes), A9 (kein DM-Ton bei einer Annahme
 * aus der Hülle) und A10 (Anruf ohne Raum nach dem Neuladen). Die Regel für
 * A10 läuft hier echt; die übrigen sind Verdrahtung in `.svelte.ts`-Dateien
 * und stehen als Text-Vertrag da (Runes laufen unter Node nicht).
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lies = (pfad: string) => readFileSync(join(webRoot, pfad), 'utf8');
const zwischen = (text: string, a: string, b: string) => {
  const i = text.indexOf(a);
  assert.ok(i >= 0, `fehlt: ${a}`);
  const j = text.indexOf(b, i);
  assert.ok(j > i, `fehlt nach ${a}: ${b}`);
  return text.slice(i, j);
};

const push = {
  channel_id: '77',
  anruf_art: 'gruppe',
  einleiter_id: '5',
  einleiter_name: 'Ada'
};

test('A10: ein klingelnder Anruf ohne Raum wird wieder angezeigt', () => {
  assert.deepEqual(ohneRaumPlan({ kennung: '9', phase: 'klingelt', kontext: push }), {
    tun: 'klingeln',
    anruf: { call_id: '9', art: 'gruppe', channel_id: '77', einleiter_id: '5' },
    name: 'Ada'
  });
});

test('A10: eine schon gegebene Annahme wird fortgesetzt, nicht verworfen', () => {
  const plan = ohneRaumPlan({ kennung: '9', phase: 'angenommen', kontext: { channel_id: '77' } });
  assert.deepEqual(plan, {
    tun: 'annehmen',
    anruf: { call_id: '9', art: 'dm', channel_id: '77', einleiter_id: '' },
    name: 'Pulse'
  });
});

test('A10: was die Seite selbst begann (ohne Kanal, ausgehend), wird beendet', () => {
  assert.deepEqual(ohneRaumPlan({ kennung: '9', phase: 'ausgehend', kontext: {} }), {
    tun: 'beenden',
    kennung: '9'
  });
  assert.deepEqual(ohneRaumPlan({ kennung: '9', phase: 'angenommen', kontext: {} }), {
    tun: 'beenden',
    kennung: '9'
  });
  assert.deepEqual(ohneRaumPlan({ kennung: '9', phase: 'ausgehend', kontext: push }), {
    tun: 'beenden',
    kennung: '9'
  });
});

test('A10: nichts gemeldet, oder eine Hülle ohne das Feld — nichts zu tun', () => {
  assert.equal(ohneRaumPlan(null), null);
  assert.equal(ohneRaumPlan(undefined), null);
  assert.equal(ohneRaumPlan({ kennung: '', phase: 'klingelt', kontext: push }), null);
});

test('A10: nach dem Laden nimmt die Seite auch einen Anruf ohne Raum auf', () => {
  const huelle = lies('src/lib/anrufe/anrufHuelle.ts');
  assert.match(huelle, /void nativAufnehmen\(anrufe\);/);
  const aufnehmen = zwischen(huelle, 'async function nativAufnehmen(', '\n}\n');
  assert.match(aufnehmen, /anrufe\.nativUebernehmen\(z\);\s*return;/);
  assert.match(aufnehmen, /const plan = ohneRaumPlan\(z\.ohneRaum\);/);
  assert.match(aufnehmen, /anrufe\.eingehend\(plan\.anruf, plan\.name, \{ ton: false \}\);/);
  assert.match(aufnehmen, /plan\.tun === 'ablehnen' \? anrufAblehnen : anrufAuflegen/);
  assert.match(aufnehmen, /void nativBeenden\('fehler', plan\.kennung\);/);
});

test('R2: ein klingelnder Anruf ohne Kontext wird abgelehnt, nicht aufgelegt', () => {
  // Auflegen auf einen klingelnden Gruppenanruf beendet ihn am Server für
  // alle; Ablehnen nur für dieses Konto.
  assert.deepEqual(ohneRaumPlan({ kennung: '9', phase: 'klingelt', kontext: {} }), {
    tun: 'ablehnen',
    kennung: '9'
  });
});

test('R3: schliesst die Hülle einen Anruf selbst, räumt die Oberfläche ab — ohne Server-Ruf', () => {
  const huelle = lies('src/lib/anrufe/anrufHuelle.ts');
  const zweig = zwischen(huelle, "if (aktion === 'beendet') {", '\n  }\n');
  assert.match(zweig, /if \(anruf\?\.id === callId\) anrufe\.ende\(callId, 'beendet', 0\);/);
  assert.doesNotMatch(zweig, /anrufAblehnen|anrufAuflegen/);
});

test('R1: das Aufräumen beendet in der Hülle nur DIESEN Anruf', () => {
  // Sonst räumte das Ende des abgelösten Anrufs den neuen gleich mit ab.
  const store = lies('src/lib/anrufe/anruf.svelte.ts');
  assert.match(store, /void nativBeenden\(grund, this\.aktiv\?\.id \|\| undefined\);/);
  assert.match(store, /await nativBeenden\('anderswo-angenommen', anruf\.id\);/);
  const huelle = lies('src/lib/anrufe/anrufHuelle.ts');
  assert.match(huelle, /anrufNativ\.beenden\(callId \? \{ grund, callId \} : \{ grund \}\)/);
});

test('A4: nach jedem await der Annahme zuerst fragen, ob es den Anruf noch gibt', () => {
  const store = lies('src/lib/anrufe/anruf.svelte.ts');
  const annehmen = zwischen(store, 'async annehmen(gegenstelle: string)', 'async ablehnen(');
  const nach = (marke: string) => {
    const i = annehmen.indexOf(marke);
    assert.ok(i >= 0, `fehlt: ${marke}`);
    return annehmen.slice(i + marke.length, i + marke.length + 40);
  };
  assert.match(nach('await anrufAnnehmen(anruf.id);'), /^\s*if \(!nochDa\(\)\) return;/);
  assert.match(
    annehmen,
    /await nativBeenden\('anderswo-angenommen', anruf\.id\);\s*\}\s*if \(!nochDa\(\)\) return;/
  );
  assert.match(annehmen, /catch \(e\) \{[\s\S]*if \(!nochDa\(\)\) return;\s*fehlerMelden/);
});

test('A6: das Ende eines hier klingelnden Anrufs wird quittiert — nur auf iOS', () => {
  const store = lies('src/lib/anrufe/anruf.svelte.ts');
  const ende = zwischen(store, 'ende(callId: string, grund: string, dauerSek: number)', 'abmelden(');
  assert.match(
    ende,
    /if \(anruf\.rolle === 'eingehend' && anruf\.zustand === 'klingelt'\) \{\s*void anrufEndeGesehen\(callId\)/
  );
  const zweit = zwischen(store, 'zweitgeraetAngenommen(callId: string)', 'gegenstelleAbgelehnt()');
  assert.match(zweit, /void anrufEndeGesehen\(callId\)/);
  const api = lies('src/lib/api/anrufe.ts');
  const quittung = zwischen(api, 'export function anrufEndeGesehen(', '\n}\n');
  assert.match(quittung, /if \(!isCapacitorIOS\(\)\) return Promise\.resolve\(\);/);
  assert.match(quittung, /\/ende-gesehen`/);
  assert.match(quittung, /\.\.\.handelndesGeraet\(\)/);
});

test('A9: eine Annahme aus der Hülle spielt keinen DM-Ton', () => {
  const store = lies('src/lib/anrufe/anruf.svelte.ts');
  assert.match(store, /if \(ton\) sounds\.play\('notification\.dm'\);/);
  const huelle = lies('src/lib/anrufe/anrufHuelle.ts');
  const kalt = zwischen(huelle, "if (!anruf && aktion === 'annehmen' && daten.channel_id)", 'anruf = anrufe.aktiv;');
  assert.match(kalt, /\{ ton: false \}/);
  // Der WebSocket-Weg klingelt weiter mit Ton.
  assert.match(lies('src/lib/ws/handlers/anrufe.ts'), /anrufe\.eingehend\(evt, gegenstelle\);/);
});
