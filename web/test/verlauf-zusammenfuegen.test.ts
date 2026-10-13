import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zusammenfuegen } from '../src/lib/verlauf/zusammenfuegen.ts';

type Posten = {
  id: string;
  kryptoId?: string | null;
  autorId?: string | null;
  bearbeitetAm: string | null;
  geloescht: boolean;
  inhalt: string;
};

function posten(id: string, inhalt: string, opts: Partial<Posten> = {}): Posten {
  return { id, inhalt, bearbeitetAm: null, geloescht: false, ...opts };
}

test('doppelte Nachrichten erscheinen genau einmal', () => {
  const lokal = [posten('1', 'hallo')];
  const vomServer = [posten('1', 'hallo')];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].id, '1');
});

test('der Server gewinnt bei bearbeiteten Nachrichten', () => {
  // Ein Text kann nach dem lokalen Ablegen bearbeitet worden sein. Waere der
  // lokale Stand staerker, zeigte der Klient dauerhaft die alte Fassung —
  // und zwar NUR bei dem, der sie damals empfangen hat.
  const lokal = [posten('1', 'alte fassung')];
  const vomServer = [posten('1', 'neue fassung', { bearbeitetAm: '2026-08-28T10:00:00Z' })];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].inhalt, 'neue fassung');
});

test('ein lokaler Grabstein ueberlebt eine Server-Antwort ohne ihn', () => {
  // Sonst kaeme eine geloeschte Nachricht beim naechsten Nachladen zurueck —
  // der Server liefert geloeschte Nachrichten grundsaetzlich nicht mehr aus,
  // "fehlt beim Server" ist hier also der Regelfall, kein Sonderfall.
  const lokal = [posten('1', 'weg', { geloescht: true })];
  const vomServer: Posten[] = [];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].geloescht, true);
});

test('ein Grabstein bleibt Grabstein, auch wenn der Server die ID noch fuehrt', () => {
  // Randfall der Regel oben: selbst wenn (aus welchem Grund auch immer) der
  // Server noch eine nicht-geloeschte Fassung derselben ID zeigt, gewinnt
  // lokal — der Grabstein ist eine bewusste Nutzeraktion auf DIESEM Geraet.
  const lokal = [posten('1', 'weg', { geloescht: true })];
  const vomServer = [posten('1', 'wieder da')];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].geloescht, true);
});

test('die Reihenfolge bleibt die der Nachrichten-IDs', () => {
  const lokal = [posten('20', 'zwanzig'), posten('9', 'neun')];
  const vomServer = [posten('100', 'hundert')];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.deepEqual(
    ergebnis.map((p) => p.id),
    ['9', '20', '100']
  );
});

test('eine AELTERE verschluesselte Nachricht sortiert vor einer NEUEREN unverschluesselten', () => {
  // Kern des Bughunt-Fund 1: `krypto/senden.ts::lokaleNachrichtId()` praegt
  // eine FEST 20-stellige ID (13-stelliger Date.now() + 7 Zufallsstellen),
  // eine echte Snowflake hat heute 17 Stellen. Ein reiner GROESSENVERGLEICH
  // der rohen IDs — ob "Laenge zuerst" (der Fehler) oder "auf gemeinsame
  // Breite auffuellen, dann lexikografisch" (die im Bugreport vorgeschlagene
  // Reparatur) — liefert fuer dieses Paar IMMER dasselbe Ergebnis: eine
  // 20-stellige Zahl ist immer groesser als eine 17-stellige, unabhaengig
  // vom Zeitpunkt. Deshalb dekodiert `vergleicheId` stattdessen die
  // eingebettete Unix-Millisekunde aus beiden ID-Schemata (s. Kommentar
  // dort) und vergleicht DIE — das faengt genau diesen Fall auf.
  //
  // Lokale ID: Date.now() = 1700000000000 (2023-11-14) + Zufall "1234567".
  const verschluesseltAelter = posten('1700000000000123456', 'verschluesselt, aelter');
  // Echte Snowflake: 5000 ms nach dem Snowflake-Epoch (2026-01-01 + 5 s) —
  // deutlich SPAETER als die lokale ID oben, obwohl numerisch/laengenmaessig
  // "kleiner". delta_ms(5000) << 22 Bit = 5000 * 4194304 = 20971520000.
  const klartextNeuer = posten('20971520000', 'klartext, neuer');
  const ergebnis = zusammenfuegen([verschluesseltAelter], [klartextNeuer]);
  assert.deepEqual(
    ergebnis.map((p) => p.id),
    ['1700000000000123456', '20971520000']
  );
});

test('ein rein lokaler Posten ohne Server-Gegenstueck bleibt erhalten', () => {
  // Der Server liefert nur ein Fenster (z.B. die neuesten 50) — aeltere
  // lokale Historie darf dadurch nicht verschwinden.
  const lokal = [posten('1', 'alt, nur lokal')];
  const vomServer = [posten('2', 'neu, vom server')];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.deepEqual(
    ergebnis.map((p) => p.id),
    ['1', '2']
  );
});

// ── Geraeteuebergreifende Dedupe ueber kryptoId (2026-09-11) ────────────────
// Dieselbe logische Nachricht traegt auf jedem Geraet eine andere lokale ID
// (der Autor seine eigene, jeder Empfaenger die Zustellungs-ID seines
// Umschlags). Ohne den kryptoId-Abgleich erschien die aus der Sicherung eines
// anderen Geraets wiederhergestellte Kopie als Duplikat.

test('Kopie vom anderen Geraet (gleiche kryptoId, andere id) erscheint nicht doppelt', () => {
  const lokal = [posten('111', 'hallo', { kryptoId: 'autor-1' })];
  const vomServer = [posten('222', 'hallo', { kryptoId: 'autor-1' })];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].id, '111'); // der bereits liegende gewinnt
});

test('Duplikate koennen auch INNERHALB der lokalen Liste liegen (Sicherungs-Ruecklauf)', () => {
  const lokal = [
    posten('111', 'hallo', { kryptoId: 'autor-1' }),
    posten('222', 'hallo', { kryptoId: 'autor-1' })
  ];
  const ergebnis = zusammenfuegen(lokal, []);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].id, '111');
});

test('ein Grabstein auf EINE Geraetekopie deckt die logische Nachricht insgesamt ab', () => {
  const lokal = [posten('111', 'hallo', { geloescht: true, kryptoId: 'autor-1' })];
  const vomServer = [posten('222', 'hallo', { kryptoId: 'autor-1' })];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].geloescht, true);
});

test('ohne kryptoId bleibt alles wie vorher: verschiedene ids sind verschiedene Nachrichten', () => {
  const lokal = [posten('111', 'hallo')];
  const vomServer = [posten('222', 'hallo')];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 2);
});

test('gleiche id mit kryptoId ueberschreibt weiter (Bearbeitungen unberuehrt)', () => {
  const lokal = [posten('111', 'alt', { kryptoId: 'autor-1' })];
  const vomServer = [posten('111', 'neu', { kryptoId: 'autor-1', bearbeitetAm: '2026-09-11T00:00:00Z' })];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].inhalt, 'neu');
});

// ── Kopie des Absenders (2026-10-13) ───────────────────────────────────────
// Die Kopie des Absenders liegt unter der vom Autor gewaehlten Id A; bis zum
// 2026-10-13 trug sie KEINE kryptoId (Altbestand), seither kryptoId = A. Das
// zweite eigene Geraet legt die Selbstzustellung unter seiner Zustellungs-Id
// mit kryptoId A ab, der Empfaenger ebenso. Alle drei sind EINE Nachricht.

const A = '1791841626624331125';
const Z_ZWEITGERAET = '103281734567890123';
const Z_EMPFAENGER = '103281734567890124';

/** Alle Reihenfolgen einer kleinen Liste. */
function reihenfolgen<T>(liste: T[]): T[][] {
  if (liste.length <= 1) return [liste];
  return liste.flatMap((x, i) =>
    reihenfolgen([...liste.slice(0, i), ...liste.slice(i + 1)]).map((rest) => [x, ...rest])
  );
}

for (const [fall, absender] of [
  ['Altbestand ohne kryptoId', posten(A, 'hallo')],
  ['neu mit kryptoId = id', posten(A, 'hallo', { kryptoId: A })]
] as const) {
  test(`Absender- + Empfaenger- + Zweitgeraet-Kopie ergeben genau eine Zeile (${fall}, jede Reihenfolge)`, () => {
    const kopien = [
      absender,
      posten(Z_ZWEITGERAET, 'hallo', { kryptoId: A }),
      posten(Z_EMPFAENGER, 'hallo', { kryptoId: A })
    ];
    for (const folge of reihenfolgen(kopien)) {
      // Alles lokal (Sicherungs-Ruecklauf) …
      assert.equal(zusammenfuegen(folge, []).length, 1, `lokal: ${folge.map((p) => p.id)}`);
      // … und verteilt auf beide Quellen.
      assert.equal(
        zusammenfuegen(folge.slice(0, 1), folge.slice(1)).length,
        1,
        `verteilt: ${folge.map((p) => p.id)}`
      );
    }
  });
}

test('der bereits liegende Posten gewinnt auch gegen die Absender-Kopie', () => {
  const ergebnis = zusammenfuegen(
    [posten(Z_ZWEITGERAET, 'hallo', { kryptoId: A })],
    [posten(A, 'hallo')]
  );
  assert.deepEqual(ergebnis.map((p) => p.id), [Z_ZWEITGERAET]);
});

test('Grabstein der Absender-Kopie (Altbestand) deckt die Kopie des Zweitgeraets ab — in beiden Reihenfolgen', () => {
  const stein = posten(A, '', { geloescht: true });
  const kopie = posten(Z_ZWEITGERAET, 'hallo', { kryptoId: A });
  for (const folge of [[stein, kopie], [kopie, stein]]) {
    const ergebnis = zusammenfuegen(folge, []);
    assert.equal(ergebnis.length, 1);
    assert.equal(ergebnis[0].geloescht, true, `Reihenfolge ${folge.map((p) => p.id)}`);
  }
});

test('Altbestand ohne jede kryptoId bleibt wie vorher', () => {
  // Verschiedene ids: verschiedene Nachrichten, auch bei gleichem Text …
  assert.equal(zusammenfuegen([posten(A, 'x')], [posten(Z_ZWEITGERAET, 'x')]).length, 2);
  // … gleiche id: eine, der Server gewinnt bei einer Bearbeitung.
  const gleich = zusammenfuegen(
    [posten(A, 'alt')],
    [posten(A, 'neu', { bearbeitetAm: '2026-10-13T00:00:00Z' })]
  );
  assert.deepEqual(gleich.map((p) => p.inhalt), ['neu']);
});

// ── Identität mit Autor-Bindung (2026-10-11) ────────────────────────────────
// Die Verfasser-Kopie trägt keine kryptoId (ihre id IST die Kennung), die
// Empfangs-Kopie trägt sie neben der Zustellungs-ID. Bis 2026-10-11 verglich
// der Merge nur kryptoId mit kryptoId — beide erschienen.

const K = '1760000000000123456';
const D = '120000000000000001';

test('Verfasser-Kopie (ohne kryptoId) und Empfangs-Kopie desselben Autors erscheinen einmal', () => {
  const ergebnis = zusammenfuegen(
    [
      posten(D, 'hallo', { kryptoId: K, autorId: '200' }),
      posten(K, 'hallo', { kryptoId: null, autorId: '200' })
    ],
    []
  );
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].id, D, 'der bereits liegende gewinnt');
});

test('ein Grabstein auf der ZWEITEN Kopie gewinnt genauso wie auf der ersten', () => {
  const lokal = [
    posten(D, 'hallo', { kryptoId: K, autorId: '200' }),
    posten(K, 'hallo', { kryptoId: K, autorId: '200', geloescht: true })
  ];
  const ergebnis = zusammenfuegen(lokal, []);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].geloescht, true, 'gelöscht heißt gelöscht, unabhängig von der Reihenfolge');
  // Und eine spätere Kopie aus der Serverantwort kommt nicht zurück.
  const mitServer = zusammenfuegen(lokal, [
    posten('120000000000000099', 'hallo', { kryptoId: K, autorId: '200' })
  ]);
  assert.deepEqual(mitServer.map((p) => p.geloescht), [true]);
});

test('Autor-Bindung: gleiche Kennung eines fremden Autors verdrängt nichts und löscht nichts', () => {
  // Bob schickt eine Nachricht mit Alices Kennung K und löscht sie wieder —
  // Alices eigene Nachricht K bleibt stehen.
  const ergebnis = zusammenfuegen(
    [
      posten(K, 'von alice', { autorId: '200' }),
      posten(D, 'von bob', { kryptoId: K, autorId: '300', geloescht: true })
    ],
    []
  );
  assert.equal(ergebnis.length, 2);
  assert.deepEqual(
    ergebnis.filter((p) => !p.geloescht).map((p) => p.inhalt),
    ['von alice']
  );
});

// ── Fälschungsfälle gegen die Identität ohne Autor (2026-10-13) ─────────────
// Die Kennung K wählt der Absender frei. Eine Identität aus Kennung allein
// (main, c5a25317) legte deshalb Bobs Nachricht mit Alices K mit Alices
// zusammen — gegen jeden der drei Fälle hier war sie offen. Alices Kopie
// liegt in beiden Formen vor: aus dem Altbestand ohne kryptoId und seit
// 2026-10-13 mit kryptoId = id.

const ALICE = '200';
const BOB = '300';
const D_ALICE = '120000000000000011';
const D_BOB = '120000000000000012';
const alicesFormen = [
  ['Altbestand', posten(K, 'von alice', { autorId: ALICE })],
  ['kryptoId = id', posten(K, 'von alice', { kryptoId: K, autorId: ALICE })]
] as const;

function sichtbar(liste: Posten[]): string[] {
  return liste.filter((p) => !p.geloescht).map((p) => p.inhalt);
}

for (const [form, alice] of alicesFormen) {
  test(`F1 Sendegerät (${form}): Bob schickt K und löscht sie selbst — Alices Nachricht bleibt`, () => {
    const bobsStein = posten(D_BOB, '', { kryptoId: K, autorId: BOB, geloescht: true });
    for (const folge of [[alice, bobsStein], [bobsStein, alice]]) {
      // Beide Reihenfolgen, je lokal und verteilt auf beide Quellen.
      assert.deepEqual(sichtbar(zusammenfuegen(folge, [])), ['von alice']);
      assert.deepEqual(sichtbar(zusammenfuegen(folge.slice(0, 1), folge.slice(1))), ['von alice']);
    }
  });

  test(`F3 (${form}): Bobs sichtbare Nachricht vor Alices Kopie — beide bleiben`, () => {
    const bobs = posten(D_BOB, 'von bob', { kryptoId: K, autorId: BOB });
    assert.deepEqual(sichtbar(zusammenfuegen([bobs, alice], [])).sort(), ['von alice', 'von bob']);
    assert.deepEqual(sichtbar(zusammenfuegen([bobs], [alice])).sort(), ['von alice', 'von bob']);
  });
}

test('F2 Empfangsgerät: Alices Kopie zuerst, Bobs Stein unter derselben Kennung danach — Alices bleibt', () => {
  const alices = posten(D_ALICE, 'von alice', { kryptoId: K, autorId: ALICE });
  const bobsStein = posten(D_BOB, '', { kryptoId: K, autorId: BOB, geloescht: true });
  assert.deepEqual(sichtbar(zusammenfuegen([alices, bobsStein], [])), ['von alice']);
  assert.deepEqual(sichtbar(zusammenfuegen([alices], [bobsStein])), ['von alice']);
});
