import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Die Verdrahtung des Push-Bughunts vom 2026-10-21 („wenn ich einen Chat
 * offen habe, kommen manchmal Nachrichten nicht an“). **Warum der Test die
 * Quelle liest:** `empfangen.ts`, `zustellungOeffnen.ts`, `gruppe/empfangen.ts`
 * und `api/postfach.ts` ziehen WASM, IndexedDB und Stores nach sich, die Nodes
 * Testläufer nicht lädt (`pnpm test:unit`-Falle in CLAUDE.md). Die Rechnungen
 * dahinter prüft `postfach-ankunft.test.ts` echt.
 */
const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');

/** Der Rumpf einer Funktion — vom Kopf bis zum nächsten Funktionskopf. */
function rumpf(quelle: string, kopf: string): string {
  const start = quelle.indexOf(kopf);
  assert.ok(start >= 0, `${kopf} fehlt`);
  const ende = quelle.indexOf('\nexport ', start + kopf.length);
  return quelle.slice(start, ende < 0 ? undefined : ende);
}

test('Befund 1: der Zyklus quittiert über quittungVersuchen und liest abgelegte Sätze nach', () => {
  const zyklus = rumpf(lies('lib/krypto/empfangen.ts'), 'async function postfachZyklus');
  assert.match(zyklus, /await quittungVersuchen\(/);
  // Kein ungeschütztes Quittieren mehr, dessen Wurf `anzuzeigen` verschluckt.
  assert.doesNotMatch(zyklus, /await postfachApi\.quittieren\(/);
  assert.ok(zyklus.indexOf('quittungVersuchen(') < zyklus.lastIndexOf('return anzuzeigen'));
  assert.match(zyklus, /abgelegtLesen: verlaufAbgelegteNachricht/);
  assert.match(lies('lib/verlauf/index.ts'), /export \{ verlaufAbgelegteNachricht \}/);
});

test('Befund 2: der Gruppenweg merkt den Stand nur vor und schreibt ihn erst über festschreiben fest', () => {
  const gruppe = rumpf(
    lies('lib/krypto/gruppe/empfangen.ts'),
    'export async function oeffneGruppennachricht'
  );
  assert.match(gruppe, /wirksamerStand\(/);
  const fest = gruppe.indexOf('festschreiben');
  const merken = gruppe.indexOf('gruppenWasserstandMerken(');
  assert.ok(fest >= 0 && merken > fest, 'gruppenWasserstandMerken nur im festschreiben-Griff');
  // Die Vormerkung reist je Zyklus mit (empfangen.ts → zustellungOeffnen).
  assert.match(lies('lib/krypto/empfangen.ts'), /zustellungOeffnen\(ident, z, vorgemerkt\)/);
});

test('Befund 3: ein Olm-Klartext für einen unbekannten Kanal wird vor dem Sichern liegen gelassen', () => {
  const oeffnen = lies('lib/krypto/zustellungOeffnen.ts');
  const pruefung = oeffnen.indexOf('istLokalerKanal(z.channel_id)');
  assert.ok(pruefung >= 0, 'Kanalprüfung fehlt');
  assert.ok(pruefung < oeffnen.indexOf('await sitzungSichern('), 'vor dem Sichern der Sitzung');
  assert.ok(
    pruefung < oeffnen.indexOf('await sitzungMitKontoAtomarSichern('),
    'vor dem atomaren Sichern mit dem Konto'
  );
  // Eine BRANDNEUE DM muss trotzdem ankommen: der Zyklus lädt die DM-Liste
  // nach, bevor er öffnet.
  const zyklus = rumpf(lies('lib/krypto/empfangen.ts'), 'async function postfachZyklus');
  const nachladen = zyklus.indexOf('await unbekannteDmsNachladen(');
  assert.ok(nachladen >= 0 && nachladen < zyklus.indexOf('verarbeiteMitWiederherstellung('));
});

test('Befund 4: Abholen und Quittieren tragen eine Frist', () => {
  const api = lies('lib/api/postfach.ts');
  for (const kopf of ['  abholen(', '  quittieren(']) {
    const start = api.indexOf(kopf);
    const stueck = api.slice(start, api.indexOf('\n  },', start));
    assert.match(stueck, /signal: fristSignal\(\)/, kopf);
  }
  assert.match(api, /AbortSignal\.timeout\(POSTFACH_FRIST_MS\)/);
});
