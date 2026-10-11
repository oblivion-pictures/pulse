import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AbbauWache } from '../src/lib/voice/abbauWache.ts';
import { huelleHaeltRaum, pausenWunsch } from '../src/lib/voice/nativAbgleich.ts';

/**
 * iOS-Bughunt 2 vom 2026-10-11, nativer Sprachraum: B2 (Auflegen und schneller
 * Neubeitritt), B3 (Anruf-Pause als Wahl gelesen) und B4 (Schutz erst ab der
 * Übernahme). Die Entscheidungen laufen hier echt; dass sie an den Stellen
 * ankommen, die sie brauchen, steht als Text-Vertrag darunter (dasselbe Muster
 * wie `start-beitritt-verdrahtung.test.ts`: Runes laufen unter Node nicht).
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lies = (pfad: string) => readFileSync(join(webRoot, pfad), 'utf8');

function warteschalter(): { p: Promise<void>; los: () => void; fehler: (e: Error) => void } {
  let los = () => undefined as void;
  let fehler = (_e: Error) => undefined as void;
  const p = new Promise<void>((ok, nein) => {
    los = ok;
    fehler = nein;
  });
  return { p, los, fehler };
}

test('B2: ein Beitritt wartet, bis das laufende Auflegen samt Abbau durch ist', async () => {
  const wache = new AbbauWache();
  const ablauf: string[] = [];
  const huelle = warteschalter();
  const auflegen = wache.fahren(async () => {
    try {
      await huelle.p;
    } finally {
      ablauf.push('teardown');
    }
  });
  assert.equal(wache.laeuft, true);
  // Der Beitritt kommt, während die Hülle noch verlässt.
  const beitritt = (async () => {
    if (wache.laeuft) await wache.abwarten();
    ablauf.push('beitritt beansprucht');
  })();
  await Promise.resolve();
  assert.deepEqual(ablauf, [], 'der Beitritt darf vor dem Abbau nichts beanspruchen');
  huelle.los();
  await Promise.all([auflegen, beitritt]);
  assert.deepEqual(ablauf, ['teardown', 'beitritt beansprucht']);
  assert.equal(wache.laeuft, false);
});

test('B2: scheitert das Auflegen, wartet der Beitritt trotzdem nur bis dahin', async () => {
  const wache = new AbbauWache();
  const huelle = warteschalter();
  const auflegen = wache.fahren(() => huelle.p);
  const warten = wache.abwarten();
  huelle.fehler(new Error('Hülle schweigt'));
  await assert.rejects(auflegen, /Hülle schweigt/);
  await warten; // wirft nicht
  assert.equal(wache.laeuft, false);
});

test('B2: ohne laufenden Abbau gibt es nichts zu warten', () => {
  assert.equal(new AbbauWache().laeuft, false);
});

test('B2: connect wartet auf das native Auflegen, BEVOR es seinen Beitritt beansprucht', () => {
  const store = lies('src/lib/voice/livekit.svelte.ts');
  const connect = store.slice(store.indexOf('async connect('), store.indexOf('const gen = ++this.#connectGen;'));
  assert.match(connect, /if \(this\.#nativAbbau\.laeuft\) await this\.#nativAbbau\.abwarten\(\);/);
  const disconnect = store.slice(store.indexOf('async disconnect('), store.indexOf('async #abbruch('));
  assert.match(disconnect, /await this\.#nativAbbau\.fahren\(async \(\) => \{[\s\S]*this\.#nativ\.verlassen\(\)[\s\S]*this\.#teardown\(\)/);
});

test('B3: während der Pause zählt die Wahl, nicht das „stumm und taub" der Pause', () => {
  assert.deepEqual(
    pausenWunsch({ pausiert: true, mikroWunsch: true, taubWunsch: false }),
    { mikro: true, taub: false }
  );
});

test('B3: ohne Pause, und bei einer Hülle ohne die Felder, bleibt es beim wirksamen Stand', () => {
  assert.equal(pausenWunsch({ pausiert: false, mikroWunsch: true, taubWunsch: false }), null);
  assert.equal(pausenWunsch({ pausiert: true }), null);
  assert.equal(pausenWunsch({ pausiert: true, mikroWunsch: true }), null);
  assert.equal(pausenWunsch({}), null);
});

test('B3: Kanalwechsel und Resume-Eintrag geben die Wahl weiter, der Gateway den wirksamen Stand', () => {
  const store = lies('src/lib/voice/livekit.svelte.ts');
  const wechsel = store.slice(store.indexOf('Channel switch keeps'), store.indexOf("await this.disconnect({ reason: 'user' });"));
  assert.match(wechsel, /startMuted: opts\.startMuted \?\? !wahl\.mikro/);
  assert.match(wechsel, /startDeafened: opts\.startDeafened \?\? wahl\.taub/);
  const resume = store.slice(store.indexOf('#saveResume(): void'), store.indexOf('#publishSelfState(): void'));
  assert.match(resume, /muted: !wahl\.mikro/);
  assert.match(resume, /deafened: wahl\.taub/);
  assert.match(resume, /this\.#nativ\.pausenWunsch \?\? \{ mikro: this\.micEnabled, taub: this\.deafened \}/);
  const gateway = store.slice(store.indexOf('#publishSelfState(): void'), store.indexOf('resyncSelfState(): void'));
  assert.match(gateway, /sendVoiceSelfState\(this\.channelId, !this\.micEnabled, this\.deafened\)/);
  const spiegel = lies('src/lib/voice/nativerRaum.svelte.ts');
  assert.equal(spiegel.match(/this\.#pause = pausenWunsch\(/g)?.length, 2, 'Vollbild UND eigenerZustand');
});

test('B4: ein Raum der Hülle zählt, solange sie einen Kanal meldet', () => {
  assert.equal(huelleHaeltRaum({ kanalId: '42' }), true);
  assert.equal(huelleHaeltRaum({ kanalId: '' }), false);
  assert.equal(huelleHaeltRaum(null), false);
});

test('B4: der Schutz gilt ab dem Laden der Seite und endet mit dem Abgleich', () => {
  const layout = lies('src/routes/app/+layout.svelte');
  const i = layout.indexOf('void spracheRaumVorhalten();');
  assert.ok(i > 0, 'fehlt im App-Layout');
  assert.ok(i < layout.indexOf('await auth.hydrate();'), 'vor der Anmeldung — sie kann dauern');
  const vorhalt = lies('src/lib/platform/spracheVorhalt.ts');
  assert.match(vorhalt, /nativerTonHalten\('vorhalt', true\)/);
  assert.match(vorhalt, /if \(entschieden \|\| !huelleHaeltRaum\(z\)\) return;/);
  const spiegel = lies('src/lib/voice/nativerRaum.svelte.ts');
  const uebernehmen = spiegel.slice(spiegel.indexOf('async uebernehmen('), spiegel.indexOf('async #abgleichen('));
  assert.match(uebernehmen, /finally \{[\s\S]*spracheVorhaltLoesen\(\);/);
});
