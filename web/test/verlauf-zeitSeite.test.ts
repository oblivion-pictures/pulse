import { test } from 'node:test';
import assert from 'node:assert/strict';

import { neuesteNachZeit, zeitBereiche } from '../src/lib/verlauf/zeitSeite.ts';
import { sortierSchluessel } from '../src/lib/verlauf/satz.ts';
import { vergleicheSnowflakeArtigeId } from '../src/lib/utils/snowflakeZeit.ts';

// Gegenprüfung 2026-10-14, V2: der lokale Verlauf blätterte über den rohen,
// gepolsterten Schlüssel, und der stellte jede lokale ID (19 Stellen) über
// jede Snowflake (18). Hier dieselbe Rechnung wie `db.ts::verlaufLesenSaetze`,
// nur über eine sortierte Schlüsselliste statt über IndexedDB.

const KANAL = '42';
const EPOCH = Date.UTC(2026, 0, 1);
const snow = (ms: number, seq = 0) =>
  ((BigInt(ms - EPOCH) << 22n) | (2n << 12n) | BigInt(seq)).toString();
const lokal = (ms: number, rest = '123456') => String(ms) + rest;

type S = { nachrichtId: string; autor: string };

/** Wie `verlaufLesenSaetze`: je Bereich ein rückwärts laufender Cursor über
 *  den Primärschlüssel, höchstens `anzahl` Treffer, dann gemischt. */
function lies(saetze: S[], opts: { vor?: string; anzahl: number }): S[] {
  const nachSchluessel = [...saetze].sort((a, b) =>
    sortierSchluessel(KANAL, a.nachrichtId) < sortierSchluessel(KANAL, b.nachrichtId) ? 1 : -1
  );
  const gefunden: S[] = [];
  for (const { von, bis, bisOffen } of zeitBereiche(opts.vor)) {
    const unten = sortierSchluessel(KANAL, von);
    const oben = sortierSchluessel(KANAL, bis);
    gefunden.push(
      ...nachSchluessel
        .filter((s) => {
          const k = sortierSchluessel(KANAL, s.nachrichtId);
          return k >= unten && (bisOffen ? k < oben : k <= oben);
        })
        .slice(0, opts.anzahl)
    );
  }
  return neuesteNachZeit(gefunden, opts.anzahl);
}

function zeitlich(liste: S[]): boolean {
  return liste.every(
    (s, i) => i === 0 || vergleicheSnowflakeArtigeId(liste[i - 1]!.nachrichtId, s.nachrichtId) < 0
  );
}

// 60 eigene Zeilen unter der lokalen ID, 60 fremde unter der Zeilen-ID des
// Servers, abwechselnd geschrieben — das Frischgerät aus dem Archiv.
const t0 = Date.UTC(2026, 9, 14, 10);
const frischgeraet: S[] = [];
for (let n = 0; n < 60; n++) {
  frischgeraet.push({ nachrichtId: lokal(t0 + n * 2000), autor: 'ich' });
  frischgeraet.push({ nachrichtId: snow(t0 + n * 2000 + 1000), autor: 'partner' });
}

test('V2: Seite 1 auf dem Frischgerät trägt beide Autoren in Zeitfolge', () => {
  const seite = lies(frischgeraet, { anzahl: 50 });
  assert.equal(seite.length, 50);
  assert.ok(zeitlich(seite));
  assert.deepEqual([...new Set(seite.map((s) => s.autor))].sort(), ['ich', 'partner']);
  const alle = [...frischgeraet].sort((a, b) => vergleicheSnowflakeArtigeId(a.nachrichtId, b.nachrichtId));
  assert.deepEqual(seite, alle.slice(-50), 'die 50 jüngsten, nicht die 50 mit dem größten Schlüssel');
});

test('V2: Hochscrollen ohne Bruch — die Seiten fügen sich zum ganzen Verlauf', () => {
  let liste = lies(frischgeraet, { anzahl: 50 });
  for (;;) {
    const aelter = lies(frischgeraet, { vor: liste[0]!.nachrichtId, anzahl: 50 });
    if (aelter.length === 0) break;
    liste = [...aelter, ...liste];
  }
  assert.equal(liste.length, 120);
  assert.ok(zeitlich(liste), 'keine Grenze in falscher Zeitfolge');
});

test('V2: alle drei ID-Formen gemischt (auch 20-stelliger Altbestand) blättern wie die Sortierung', () => {
  const gemischt: S[] = [];
  let zufall = 7;
  const naechste = () => (zufall = (zufall * 1103515245 + 12345) % 2147483648);
  for (let n = 0; n < 200; n++) {
    const ms = t0 + (naechste() % 100000);
    const art = naechste() % 3;
    const id = art === 0 ? snow(ms, n) : art === 1 ? lokal(ms, String(100000 + n)) : lokal(ms, String(1000000 + n));
    gemischt.push({ nachrichtId: id, autor: String(art) });
  }
  const alle = [...gemischt].sort((a, b) => vergleicheSnowflakeArtigeId(a.nachrichtId, b.nachrichtId));
  let liste = lies(gemischt, { anzahl: 30 });
  for (;;) {
    const aelter = lies(gemischt, { vor: liste[0]!.nachrichtId, anzahl: 30 });
    if (aelter.length === 0) break;
    liste = [...aelter, ...liste];
  }
  assert.deepEqual(liste, alle);
});

test('zeitBereiche: eine Grenze vor dem Epoch der Snowflakes liefert nichts, eine vorläufige ID alles bis zu ihrer Zeit', () => {
  assert.deepEqual(lies(frischgeraet, { vor: '1', anzahl: 50 }), []);
  const vorlaeufig = `tmp-n-${t0 + 3000}-abcd`;
  const davor = lies(frischgeraet, { vor: vorlaeufig, anzahl: 50 });
  assert.deepEqual(
    davor.map((s) => s.autor),
    ['ich', 'partner', 'ich', 'partner'],
    'die Sätze bis einschließlich derselben Millisekunde'
  );
});
