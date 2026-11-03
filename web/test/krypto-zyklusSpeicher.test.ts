import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { zyklusSpeicherAnlegen } from '../src/lib/krypto/zyklusSpeicher.ts';

// Fund 3 (DM-Bughunt 2026-11-02): 60 Aufbau-Umschläge desselben Absenders
// fragten das Verzeichnis 60-mal, der 61. lief ins 429.
test('Fund 3: je Absender höchstens ein Abruf je Zyklus', async () => {
  const abrufe: string[] = [];
  const speicher = zyklusSpeicherAnlegen(async (konto) => {
    abrufe.push(konto);
    return [`geraet-von-${konto}`];
  });
  const ergebnisse = await Promise.all(
    Array.from({ length: 80 }, (_, i) => speicher.holen(i % 2 === 0 ? 'a' : 'b'))
  );
  assert.deepEqual(abrufe.sort(), ['a', 'b']);
  assert.deepEqual(ergebnisse[0], ['geraet-von-a']);
  assert.deepEqual(ergebnisse[1], ['geraet-von-b']);
  assert.equal(speicher.aufgeschoben, false);
});

test('Fund 3: ein gescheiterter Abruf bleibt stehen und meldet „aufgeschoben"', async () => {
  let abrufe = 0;
  const speicher = zyklusSpeicherAnlegen(async () => {
    abrufe += 1;
    throw new Error('429');
  });
  await assert.rejects(speicher.holen('a'));
  await assert.rejects(speicher.holen('a'));
  // Kein zweiter Abruf in denselben Fehler hinein.
  assert.equal(abrufe, 1);
  assert.equal(speicher.aufgeschoben, true);
});

test('Fund 3: ein neuer Zyklus fragt wieder', async () => {
  let abrufe = 0;
  const laden = async () => {
    abrufe += 1;
    return abrufe;
  };
  assert.equal(await zyklusSpeicherAnlegen(laden).holen('a'), 1);
  assert.equal(await zyklusSpeicherAnlegen(laden).holen('a'), 2);
});

// Verdrahtung: die drei Module ziehen den WASM-/IndexedDB-Kegel und sind für
// Nodes Läufer unerreichbar — geprüft wird deshalb der Quelltext.
const HIER = dirname(fileURLToPath(import.meta.url));
const lies = (pfad: string) => readFileSync(join(HIER, '../src/lib', pfad), 'utf8');

test('Fund 3, Verdrahtung: die Bindung fragt über den Zyklus-Speicher, nicht direkt', () => {
  const bindung = lies('krypto/empfangsbindung.ts');
  const absenderBinden = bindung.slice(bindung.indexOf('export async function absenderBinden'));
  assert.match(absenderBinden, /await auskunft\.holen\(absenderUserId\)/);
  assert.doesNotMatch(absenderBinden, /keysApi\.buendelAuskunft/);
});

test('Fund 3, Verdrahtung: ein Speicher je Zyklus, „aufgeschoben" plant den Nachlauf', () => {
  const empfangen = lies('krypto/empfangen.ts');
  const zyklus = empfangen.slice(empfangen.indexOf('async function postfachZyklus'));
  assert.match(zyklus, /const auskunft = auskunftsSpeicherAnlegen\(\);/);
  assert.match(zyklus, /zustellungOeffnen\(ident, z, vorgemerkt, auskunft\)/);
  assert.match(zyklus, /aufgeschoben: auskunft\.aufgeschoben/);
  const chat = lies('ws/handlers/chat.ts');
  assert.match(chat, /if \(neue\.aufgeschoben && !stumm\) postfachWiederholung\.fehlgeschlagen\(\);/);
});
