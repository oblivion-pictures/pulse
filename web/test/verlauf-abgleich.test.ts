import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ermittleGeloeschteIds } from '../src/lib/verlauf/abgleich.ts';
import { neuesteNachZeit, serverAnker, zeitBereiche } from '../src/lib/verlauf/zeitSeite.ts';
import { sortierSchluessel } from '../src/lib/verlauf/satz.ts';

/** Eine nicht volle Antwort unter einem hohen Anker: deckt alles darunter ab. */
const ALLES = { before: '1000', limit: 100 };

test('eine ID, die lokal vorhanden ist und beim Server auftaucht, gilt nicht als geloescht', () => {
  const lokal = [{ id: '1' }, { id: '2' }];
  const vomServer = [{ id: '1' }, { id: '2' }];
  assert.deepEqual(ermittleGeloeschteIds(lokal, vomServer, ALLES), []);
});

test('eine lokal vorhandene ID, die beim Server fehlt, gilt als geloescht', () => {
  // Kern von Bughunt Fund 3: eine aeltere, bereits lokal ausgelieferte Seite
  // wurde nie gegen den Server abgeglichen — eine zwischenzeitliche
  // Loeschung (anderes Geraet, oder waehrend dieses Geraet offline war)
  // blieb dadurch fuer immer sichtbar. Der Server liefert geloeschte
  // Nachrichten grundsaetzlich nicht aus — "fehlt in der Antwort" ist hier
  // also der Regelfall fuer eine Loeschung.
  const lokal = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const vomServer = [{ id: '1' }, { id: '3' }];
  assert.deepEqual(ermittleGeloeschteIds(lokal, vomServer, ALLES), ['2']);
});

test('mehrere fehlende IDs werden alle gemeldet, in ihrer lokalen Reihenfolge', () => {
  const lokal = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
  const vomServer = [{ id: '1' }];
  assert.deepEqual(ermittleGeloeschteIds(lokal, vomServer, ALLES), ['2', '3', '4']);
});

test('eine leere Serverantwort meldet jede lokale ID als geloescht', () => {
  const lokal = [{ id: '1' }, { id: '2' }];
  assert.deepEqual(ermittleGeloeschteIds(lokal, [], ALLES), ['1', '2']);
});

test('eine leere lokale Seite meldet nichts', () => {
  assert.deepEqual(ermittleGeloeschteIds([], [{ id: '1' }], ALLES), []);
});

test('verschluesselte Nachrichten gelten NIE als geloescht, nur weil der Server sie nicht kennt', () => {
  // 2026-09-03: der Server hat verschluesselte DMs nie gesehen — „fehlt in
  // der Antwort" ist fuer sie der Normalzustand. Ein Hochscrollen loeschte
  // sonst die ganze lokale Seite samt Grabsteinen im Archiv.
  const lokal = [
    { id: '1', verschluesselt: true },
    { id: '2' },
    { id: '3', verschluesselt: true },
    { id: '4', verschluesselt: false }
  ];
  const vomServer: { id: string }[] = [];
  assert.deepEqual(ermittleGeloeschteIds(lokal, vomServer, ALLES), ['2', '4']);
});

// Gegenprüfung 2026-10-14, W1: eine gemischte DM aus der Umstellungszeit.
// 30 Klartext-Nachrichten der Partnerin und 30 eigene verschlüsselte vor K0
// (eigene, älteste angezeigte), danach 120 Klartext-Nachrichten.
const KANAL = '42';
const EPOCH = Date.UTC(2026, 0, 1);
const snow = (ms: number) => ((BigInt(ms - EPOCH) << 22n) | (2n << 12n)).toString();
const lokaleId = (ms: number) => String(ms) + '123456';
type S = { id: string; nachrichtId: string; verschluesselt: boolean };
const satz = (id: string, verschluesselt: boolean): S => ({ id, nachrichtId: id, verschluesselt });
const t0 = Date.UTC(2026, 8, 5, 10);
const vorK0: S[] = [];
for (let n = 0; n < 30; n++) {
  vorK0.push(satz(snow(t0 - 100000 + n * 2000), false));
  vorK0.push(satz(lokaleId(t0 - 99000 + n * 2000), true));
}
const K0 = lokaleId(t0);
const danach = Array.from({ length: 120 }, (_, n) => satz(snow(t0 + 1000 + n * 1000), false));
const alle = [...vorK0, satz(K0, true), ...danach];

/** Wie `db.ts::verlaufLesenSaetze` (s. `verlauf-zeitSeite.test.ts`). */
function lokaleSeite(saetze: S[], vor: string, anzahl: number): S[] {
  const schluessel = (s: S) => sortierSchluessel(KANAL, s.nachrichtId);
  const absteigend = [...saetze].sort((a, b) => (schluessel(a) < schluessel(b) ? 1 : -1));
  const treffer: S[] = [];
  for (const { von, bis, bisOffen } of zeitBereiche(vor)) {
    const u = sortierSchluessel(KANAL, von);
    const o = sortierSchluessel(KANAL, bis);
    const imBereich = absteigend.filter((s) => {
      const k = schluessel(s);
      return k >= u && (bisOffen ? k < o : k <= o);
    });
    treffer.push(...imBereich.slice(0, anzahl));
  }
  return neuesteNachZeit(treffer, anzahl);
}

/** Wie `routes/messages.py::list_messages`: nur Klartext, numerisch < before. */
function server(saetze: S[], before: string, limit: number): { id: string }[] {
  return saetze
    .filter((s) => !s.verschluesselt && BigInt(s.id) < BigInt(before))
    .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
    .slice(0, limit);
}

test('W1: eine volle Antwort urteilt nicht über Klartext unterhalb ihrer kleinsten ID', () => {
  // Der alte Anker K0 (lokale ID) lag numerisch über jeder Snowflake: der
  // Server lieferte die 100 neuesten Klartext-Nachrichten NACH K0, die
  // lokale Seite hielt die 30 davor. Ohne Fenster galten alle 30 als gelöscht.
  const lokal = lokaleSeite(alle, K0, 100);
  assert.equal(lokal.filter((s) => !s.verschluesselt).length, 30);
  const geloescht = ermittleGeloeschteIds(lokal, server(alle, K0, 100), { before: K0, limit: 100 });
  assert.deepEqual(geloescht, []);
});

test('W1: über den Snowflake-Anker wird eine echte Löschung weiter erkannt', () => {
  const before = serverAnker(K0);
  assert.ok(before !== null);
  const lokal = lokaleSeite(alle, K0, 100);
  const weg = vorK0[10].id;
  const antwort = server(alle.filter((s) => s.id !== weg), before, 100);
  // Die Antwort ist genau der Klartext vor K0 (29 nach der Löschung).
  assert.equal(antwort.length, 29);
  assert.deepEqual(ermittleGeloeschteIds(lokal, antwort, { before, limit: 100 }), [weg]);
});

test('W1: eine volle Antwort prüft nur ihr Fenster, eine kurze alles unter dem Anker', () => {
  const lokal = [{ id: '5' }, { id: '7' }, { id: '9' }, { id: '12' }];
  const voll = [{ id: '11' }, { id: '8' }];
  assert.deepEqual(ermittleGeloeschteIds(lokal, voll, { before: '12', limit: 2 }), ['9']);
  assert.deepEqual(ermittleGeloeschteIds(lokal, voll, { before: '12', limit: 3 }), ['5', '7', '9']);
});

test('W1: der Server-Anker ist immer eine Snowflake vor derselben Zeit', () => {
  const s = snow(t0);
  assert.equal(serverAnker(s), s);
  const anker = BigInt(serverAnker(K0) ?? '0');
  assert.ok(vorK0.every((x) => x.verschluesselt || BigInt(x.id) < anker));
  assert.ok(danach.every((x) => BigInt(x.id) >= anker));
  // 20 Stellen (Altbestand) und die vorläufige Form: beide über 2^63−1 bzw.
  // keine Zahl, der Anker bleibt im Snowflake-Bereich.
  for (const vor of [String(t0) + '1234567', `tmp-n-${t0}-1`]) {
    assert.equal(serverAnker(vor), String(anker));
  }
  assert.ok(anker < 2n ** 63n);
  assert.equal(serverAnker(String(EPOCH - 1) + '123456'), null);
});
