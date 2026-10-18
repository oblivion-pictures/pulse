import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Ton-Diagnose der iOS-App (diagnose/iosTonDiagnose.ts): automatisch gesendet
// wird nur bei einem Anlass, je Anlass EIN Bericht, gedrosselt (Eigentümer-
// Entscheid 2026-10-17). Dazu die Verträge zwischen Web und Hülle, deren
// Bruch niemand bemerken würde: ein Feld oder Ereignis, das drüben anders
// heisst, tut einfach nichts.

const ablage = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => ablage.get(k) ?? null,
  setItem: (k: string, v: string) => void ablage.set(k, v),
  removeItem: (k: string) => void ablage.delete(k)
};
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', maxTouchPoints: 5 },
  configurable: true
});

const d = await import('../src/lib/diagnose/iosTonDiagnose.ts');
const MIN = 60_000;

test('Drossel: höchstens einer je 10 min, fünf je Tag, ein offener sammelt', () => {
  const t = 10_000_000_000;
  assert.equal(d.berichtEntscheiden([], t, false), 'neu');
  assert.equal(d.berichtEntscheiden([], t, true), 'anhaengen');
  assert.equal(d.berichtEntscheiden([t - 9 * MIN], t, false), 'gedrosselt');
  assert.equal(d.berichtEntscheiden([t - 11 * MIN], t, false), 'neu');
  const fuenf = [1, 2, 3, 4, 5].map((h) => t - h * 60 * MIN);
  assert.equal(d.berichtEntscheiden(fuenf, t, false), 'gedrosselt');
  const gestern = fuenf.map((x) => x - 24 * 60 * MIN);
  assert.equal(d.berichtEntscheiden(gestern, t, false), 'neu');
  // Eine zurückgesprungene Uhr sperrt nicht.
  assert.equal(d.berichtEntscheiden([t + 5 * MIN], t, false), 'neu');
});

test('Bericht: nur Zeilen dieses Bausteins, ab zwei Minuten vor dem Anlass', () => {
  const start = 1_000_000;
  const zeilen = d.berichtZeilen(
    [
      { ts: start - 3 * MIN, baustein: 'ios_ton', kategorie: 'zu_alt', anzahl: 1 },
      { ts: start - MIN, baustein: 'ios_ton', kategorie: 'ton', anzahl: 2, kontext: { ton: 'x' } },
      { ts: start, baustein: 'api', kategorie: 'fetch_failed', anzahl: 1 },
      { ts: start + 500, baustein: 'ios_ton', kategorie: 'wache_stufe', anzahl: 1 }
    ],
    start
  );
  assert.deepEqual(
    zeilen.map((z) => z.art),
    ['ton', 'wache_stufe']
  );
  assert.equal(zeilen[1].s, 60.5);
});

test('Anlass: genau ein Bericht, der Rest hängt sich an; normaler Verlauf sendet nie', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 50_000_000_000 });
  const gesendet: { anlaesse: string[]; zeilen: unknown[] }[] = [];
  d.berichtSenderSetzen(async (b) => {
    gesendet.push(b);
    return true;
  });
  d.iosTonMelden('beitritt');
  d.iosTonMelden('ton', { ton: 'voice.self_join' });
  t.mock.timers.tick(d.SAMMEL_MS + 1);
  assert.equal(gesendet.length, 0, 'ohne Anlass kein Bericht');

  d.iosTonMelden('wache_stufe', { stufe: 1 });
  d.iosTonMelden('wache_stufe', { stufe: 2 });
  d.iosTonMelden('mikro_tot');
  t.mock.timers.tick(d.SAMMEL_MS + 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gesendet.length, 1);
  assert.deepEqual(gesendet[0].anlaesse.sort(), ['mikro_tot', 'wache_stufe']);

  // Fünf Minuten später: gedrosselt.
  t.mock.timers.tick(5 * MIN);
  d.iosTonMelden('media_reset');
  t.mock.timers.tick(d.SAMMEL_MS + 1);
  await Promise.resolve();
  assert.equal(gesendet.length, 1);
  d.berichtSenderSetzen(null);
});

test('T4: der Bericht bleibt unter 60 KiB, die ältesten Zeilen gehen zuerst', () => {
  const zeilen = Array.from({ length: 400 }, (_, i) => ({ i, f: 'x'.repeat(300) }));
  const text = d.berichtKappen(zeilen, (rest, verworfen) => JSON.stringify({ rest, verworfen }));
  assert.ok(new TextEncoder().encode(text).length <= d.BERICHT_MAX_BYTES);
  const daten = JSON.parse(text) as { rest: { i: number }[]; verworfen: number };
  assert.equal(daten.rest.at(-1)?.i, 399, 'die jüngste Zeile bleibt');
  assert.equal(daten.verworfen + daten.rest.length, 400);
  // Was passt, bleibt unverändert.
  assert.equal(d.berichtKappen([1, 2], (r, v) => `${r.length}/${v}`), '2/0');
});

test('T4: auch ein gescheiterter Versand zählt für die Drossel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 90_000_000_000 });
  let versuche = 0;
  d.berichtSenderSetzen(async () => {
    versuche++;
    throw new Error('kein Netz');
  });
  d.iosTonMelden('media_reset');
  t.mock.timers.tick(d.SAMMEL_MS + 1);
  await Promise.resolve();
  t.mock.timers.tick(MIN);
  d.iosTonMelden('media_reset');
  t.mock.timers.tick(d.SAMMEL_MS + 1);
  await Promise.resolve();
  assert.equal(versuche, 1);
  d.berichtSenderSetzen(null);
});

test('Web und Hülle sprechen dieselben Felder und Ereignisse', () => {
  const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const plugin = lesen('../../mobile/ios/App/App/SprachePlugin.swift');
  const wache = lesen('../../mobile/ios/App/App/SpracheMikroWache.swift');
  const web = lesen('../src/lib/platform/iosSprache.ts');
  const webWache = lesen('../src/lib/platform/iosSpracheWache.ts');
  for (const feld of ['kannNeuVerbinden']) {
    assert.match(web, new RegExp(`${feld}:`), `Web schickt ${feld} nicht`);
    assert.match(plugin, new RegExp(`call\\.get\\w+\\("${feld}"\\)`), `Hülle liest ${feld} nicht`);
  }
  for (const ereignis of ['mikroBereit', 'mikroAusfall', 'mikroTot']) {
    assert.match(wache, new RegExp(`wacheMelden\\("${ereignis}"`), `Hülle meldet ${ereignis} nicht`);
    assert.match(webWache, new RegExp(`addListener\\('${ereignis}'`), `Web hört ${ereignis} nicht`);
  }
  assert.match(lesen('../../mobile/ios/App/App/SpracheRaumNeustart.swift'), /melde\?\("diagnose"/);
  assert.match(webWache, /addListener\('diagnose'/);
  // Die Aktion der nativen Ansicht heisst auf beiden Seiten gleich.
  assert.match(lesen('../../mobile/ios/App/App/SpracheRaum.swift'), /case neuVerbinden/);
  assert.match(lesen('../src/lib/voice/nativerRaum.svelte.ts'), /e\.aktion === 'neuVerbinden'/);
});

test('jeder Anlass der Hülle ist im Web als Anlass bekannt', () => {
  const swift = ['SpracheMikroWache.swift', 'SpracheRaumNeustart.swift', 'SpracheRaumSession.swift', 'SpracheRaum.swift']
    .map((f) => readFileSync(new URL(`../../mobile/ios/App/App/${f}`, import.meta.url), 'utf8'))
    .join('\n');
  // Auch die Arten aus einem `a ? "x" : "y"` im ersten Argument.
  const arten = new Set(
    [...swift.matchAll(/diagMelden\(([^,]+),/g)].flatMap((x) =>
      [...x[1].matchAll(/"(\w+)"/g)].map((y) => y[1])
    )
  );
  for (const a of ['unterbrechung_haengt', 'media_reset', 'maschine_neu_fehler', 'callkit_haengt']) {
    assert.ok(arten.has(a), `Hülle meldet ${a} nicht`);
    assert.ok(d.ANLAESSE.has(a), `${a} ist kein Anlass`);
  }
  // Ein HQ-Bild, das nicht anläuft, löst aus.
  for (const a of [
    'bild_gesperrt',
    'bild_haengt',
    'bild_fehler',
    'bild_pausiert_von_webkit',
    'bild_pausiert_nach_nativ_ton'
  ]) {
    assert.ok(d.ANLAESSE.has(a), `${a} ist kein Anlass`);
  }
  // Gewöhnlicher Verlauf und ein gelungener Bildstart lösen nie aus.
  for (const a of ['beitritt', 'verlassen', 'unterbrechung_beginn', 'maschine_neu', 'wache_erholt', 'bild_spielt', 'bild_nach_geste', 'bild_abgebrochen']) {
    assert.ok(!d.ANLAESSE.has(a), `${a} darf kein Anlass sein`);
  }
});

// --- Review B11: eigenes Budget für bild_*, Anlass überlebt das App-Ende ---

test('B11: bild_* und alles andere haben getrennte Budgets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 120_000_000_000 });
  const gesendet: string[][] = [];
  d.berichtSenderSetzen(async (b) => {
    gesendet.push(b.anlaesse);
    return true;
  });
  assert.equal(d.gruppeVon('bild_haengt'), 'bild');
  assert.equal(d.gruppeVon('mikro_tot'), 'ton');
  d.iosTonMelden('bild_haengt');
  t.mock.timers.tick(d.SAMMEL_MS + 1);
  await Promise.resolve();
  assert.equal(gesendet.length, 1);
  // Eine Minute später: das echte Mikro-Problem wird NICHT vom Bildstart gedrosselt …
  t.mock.timers.tick(MIN);
  d.iosTonMelden('mikro_tot');
  t.mock.timers.tick(d.SAMMEL_MS + 1);
  await Promise.resolve();
  assert.deepEqual(gesendet.at(-1), ['mikro_tot']);
  // … und ein zweiter Bildstart-Anlass ist durch das Bild-Budget gedrosselt.
  t.mock.timers.tick(MIN);
  d.iosTonMelden('bild_fehler');
  t.mock.timers.tick(d.SAMMEL_MS + 1);
  await Promise.resolve();
  assert.equal(gesendet.length, 2);
  d.berichtSenderSetzen(null);
});

test('B11: ein offener Anlass wird gemerkt und beim nächsten Start nachgereicht', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 200_000_000_000 });
  const SCHLUESSEL = 'pulse.diag.ios_ton_offen';
  d.berichtSenderSetzen(async () => true);
  d.iosTonMelden('mikro_tot');
  const gemerkt = JSON.parse(ablage.get(SCHLUESSEL) ?? 'null') as { anlaesse: string[] } | null;
  assert.deepEqual(gemerkt?.anlaesse, ['mikro_tot'], 'der Anlass steht im Speicher');
  // Die App endet, bevor der Sammler feuert: neuer Start = neues Modul-Leben,
  // hier nachgestellt durch einen frischen Sender bei gleichem Speicher.
  const alterBestand = ablage.get(SCHLUESSEL);
  d.berichtSenderSetzen(null);
  ablage.delete('pulse.diag.ios_ton_berichte');
  t.mock.timers.tick(15 * MIN);
  ablage.set(SCHLUESSEL, alterBestand ?? '');
  const gesendet: string[][] = [];
  d.berichtSenderSetzen(async (b) => {
    gesendet.push(b.anlaesse);
    return true;
  });
  await Promise.resolve();
  assert.equal(gesendet.length, 1);
  assert.deepEqual(gesendet[0].sort(), ['mikro_tot', 'nachgereicht']);
  assert.equal(ablage.has(SCHLUESSEL), false, 'nach dem Versand ist der Merker weg');
  d.berichtSenderSetzen(null);
});

test('B11: Gemerktes wird nur aus bekannten Anlässen und nur frisch gelesen', () => {
  const jetzt = 10 * 24 * 60 * MIN;
  const lesen = (o: unknown) => d.offenenBerichtLesen(JSON.stringify(o), jetzt);
  assert.deepEqual(lesen({ start: jetzt - MIN, anlaesse: ['mikro_tot', 'geheim:abc', 7] }), {
    start: jetzt - MIN,
    anlaesse: ['mikro_tot']
  });
  assert.equal(lesen({ start: jetzt - MIN, anlaesse: ['unbekannt'] }), null);
  assert.equal(lesen({ start: jetzt - 25 * 60 * MIN, anlaesse: ['mikro_tot'] }), null, 'zu alt');
  assert.equal(lesen({ start: jetzt + MIN, anlaesse: ['mikro_tot'] }), null, 'Uhr zurückgesprungen');
  assert.equal(d.offenenBerichtLesen('kein json', jetzt), null);
  assert.equal(d.offenenBerichtLesen(null, jetzt), null);
});
