import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EintragsGruppen } from '../src/lib/sicherung/eintragsGruppen.ts';
import { NUTZLAST_FASSUNG, type AblageNachricht } from '../src/lib/ablage/nutzlast.ts';
import type { SicherungEintrag } from '../src/lib/sicherung/nutzlast.ts';

// Dieselbe Nachricht in drei Formen: beim Verfasser K (ohne kryptoId), beim
// Empfänger unter der Zustellungs-ID D mit kryptoId K.
const KANAL = '777';
const K = '1760000000000123456';
const D = '120000000000000001';
const ALICE = '200';
const BOB = '300';

function eintrag(n: Partial<AblageNachricht> & { id: string }): SicherungEintrag {
  return {
    fassung: 1,
    kanalId: KANAL,
    nachricht: {
      fassung: NUTZLAST_FASSUNG,
      autor: ALICE,
      inhalt: 'hallo',
      zeit: '2026-10-10T10:00:00Z',
      bearbeitet: null,
      antwortAuf: null,
      anhaenge: [],
      ...n
    }
  };
}

/** Ein Grabstein-Rahmen in der Fassung von `andock.ts::sicherungGrabstein`
 *  vor 2026-10-11: nur die ID, kein Autor. */
function alterStein(id: string): SicherungEintrag {
  return eintrag({ id, autor: '', inhalt: '', geloescht: true });
}

/** Ein Grabstein-Rahmen mit Autor (seit 2026-10-11), ohne Kennung: er
 *  nennt nur seine lokale ID, die Gruppe verbinden erst die Rahmen. */
function stein(id: string): SicherungEintrag {
  return eintrag({ id, inhalt: '', geloescht: true });
}

function lies(...eintraege: SicherungEintrag[]): SicherungEintrag[] {
  const gruppen = new EintragsGruppen();
  for (const e of eintraege) gruppen.aufnehmen(e);
  return gruppen.ergebnis();
}

const verfasser = eintrag({ id: K });
const empfang = eintrag({ id: D, kryptoId: K });

test('Verfasser-Kopie und Empfangs-Kopie werden EIN Eintrag — in beiden Reihenfolgen', () => {
  assert.equal(lies(verfasser, empfang).length, 1);
  assert.equal(lies(empfang, verfasser).length, 1);
});

test('die reichere Fassung ersetzt die liegende, statt neben ihr zu stehen', () => {
  const arm = eintrag({ id: '6001', kryptoId: 'K1' });
  const reich = eintrag({
    id: '6002',
    kryptoId: 'K1',
    anhaenge: [{ id: 'a1', name: 'f', mime: 'image/png', groesse: 3 }]
  });
  const aus = lies(arm, reich);
  assert.equal(aus.length, 1);
  assert.equal(aus[0]!.nachricht.anhaenge.length, 1);
});

test('Autor-Bindung: Bobs Nachricht mit Alices Kennung bleibt eine eigene Zeile', () => {
  const faelschung = eintrag({ id: '120000000000000002', autor: BOB, kryptoId: K });
  assert.equal(lies(verfasser, faelschung).length, 2);
});

test('Grabstein mit Autor auf D trifft die Nachricht auch, wenn die Verfasser-Kopie K zuerst kam', () => {
  // Drei Rahmen aus zwei Ketten — die Kette des Verfassers wird zuerst
  // gelesen, dann die des Empfängers (neueste Rahmen zuerst: Stein vor
  // Nachricht). Vorher: Stein für D neben einer sichtbaren K.
  for (const folge of [
    [verfasser, stein(D), empfang],
    [verfasser, empfang, stein(D)],
    [stein(D), empfang, verfasser],
    [stein(D), verfasser, empfang]
  ]) {
    // Der Stein kennt K nicht; erst der Rahmen D verbindet beide. Am Ende
    // des Laufs ist die Gruppe in jeder Reihenfolge verbunden.
    const aus = lies(...folge);
    assert.equal(
      aus.filter((e) => e.nachricht.geloescht !== true).length,
      0,
      `nichts Sichtbares in der Folge ${folge.map((e) => e.nachricht.id).join(',')}`
    );
  }
});

test('eine von einem Stein mit Autor getroffene Gruppe nennt für JEDE ihrer lokalen IDs einen Stein, mit Autor und Kennung', () => {
  const aus = lies(verfasser, empfang, stein(D));
  assert.deepEqual(aus.map((e) => e.nachricht.id).sort(), [D, K].sort());
  for (const e of aus) {
    assert.equal(e.nachricht.geloescht, true);
    assert.equal(e.nachricht.autor, ALICE);
    assert.equal(e.nachricht.kryptoId, K);
    assert.equal(e.nachricht.inhalt, '');
  }
});

test('ein Grabstein läuft NICHT über die Identität: ein Stein auf eine fremde ID lässt K stehen', () => {
  // Der Stein nennt nur eine lokale ID. Liegt sie in keiner Gruppe, entsteht
  // ein eigener Stein — die Kennung K berührt er nicht.
  const aus = lies(verfasser, alterStein('120000000000000099'));
  assert.deepEqual(
    aus.filter((e) => e.nachricht.geloescht !== true).map((e) => e.nachricht.id),
    [K]
  );
});

test('Grabstein vor Nachricht derselben ID: die Nachricht bleibt gelöscht', () => {
  const aus = lies(alterStein(K), verfasser);
  assert.equal(aus.length, 1);
  assert.equal(aus[0]!.nachricht.geloescht, true);
});

test('zwei Rahmen derselben ID von verschiedenen Autoren bleiben zwei — keiner überschreibt den anderen', () => {
  const vonAlice = eintrag({ id: '100', inhalt: 'alice' });
  const vonBob = eintrag({ id: '100', autor: BOB, inhalt: 'bob' });
  assert.deepEqual(lies(vonAlice, vonBob).map((e) => e.nachricht.inhalt).sort(), ['alice', 'bob']);
});

test('ein Stein mit fremdem Autor löscht die Nachricht derselben ID nicht', () => {
  const stein = eintrag({ id: '100', autor: BOB, inhalt: '', geloescht: true });
  const aus = lies(eintrag({ id: '100' }), stein);
  assert.deepEqual(
    aus.filter((e) => e.nachricht.geloescht !== true).map((e) => e.nachricht.autor),
    [ALICE]
  );
});

// Gegenprüfung 2026-10-12, Fund 6: die Kennung der Gruppe setzte der ERSTE
// Rahmen. Ein Rahmen ohne kryptoId (Zustellungs-ID D, aus der Zeit vor
// 2ca26243) vor dem mit kryptoId K — und alle Steine der Gruppe trugen D als
// Kennung, die Kopie unter K traf beim Wiederherstellen keiner.
test('Fund 6: eine echte kryptoId geht vor dem Rückfall auf die lokale ID, in jeder Reihenfolge', () => {
  const altOhneKennung = eintrag({ id: D });
  for (const reihe of [
    [altOhneKennung, empfang, stein(D)],
    [empfang, altOhneKennung, stein(D)],
    [stein(D), altOhneKennung, empfang]
  ]) {
    const aus = lies(...reihe);
    assert.ok(aus.length > 0);
    for (const e of aus) {
      assert.equal(e.nachricht.geloescht, true);
      assert.equal(e.nachricht.kryptoId, K, `Reihenfolge ${reihe.map((r) => r.nachricht.id).join(',')}`);
    }
  }
});

test('Fund 6: ein Stein mit Autor und abweichender Kennung gilt als echte Kennung', () => {
  const stein = eintrag({ id: D, inhalt: '', geloescht: true, kryptoId: K });
  const aus = lies(eintrag({ id: D }), stein);
  assert.deepEqual(
    aus.map((e) => e.nachricht.kryptoId),
    aus.map(() => K)
  );
});

// Gegenprüfung 2026-10-14, V1 (Eigentümer-Entscheid 2026-10-13, „nie über
// Kennung"): ein Stein ohne Autor gehört zu keiner Gruppe. Er kommt heraus,
// wie er gelesen wurde, und die Gruppe seiner ID zeigt den Rahmen unter einer
// anderen lokalen ID weiter.
test('V1: ein Stein ohne Autor trifft nur seine eigene ID — in jeder Reihenfolge', () => {
  for (const folge of [
    [verfasser, alterStein(K), empfang],
    [alterStein(K), verfasser, empfang],
    [empfang, verfasser, alterStein(K)],
    [verfasser, empfang, alterStein(D)],
    [alterStein(D), empfang, verfasser]
  ]) {
    const name = folge.map((e) => e.nachricht.id).join(',');
    const aus = lies(...folge);
    const steine = aus.filter((e) => e.nachricht.geloescht === true);
    const sichtbar = aus.filter((e) => e.nachricht.geloescht !== true);
    assert.equal(steine.length, 1, `ein Stein in ${name}`);
    assert.equal(steine[0]!.nachricht.autor, '', `ohne Autor in ${name}`);
    assert.equal(steine[0]!.nachricht.kryptoId, undefined, `ohne Kennung in ${name}`);
    assert.equal(sichtbar.length, 1, `die Nachricht bleibt in ${name}`);
    assert.notEqual(sichtbar[0]!.nachricht.id, steine[0]!.nachricht.id, `unter der anderen ID in ${name}`);
  }
});

test('V1: trifft der Stein ohne Autor jede lokale ID der Gruppe, bleibt nichts sichtbar', () => {
  const aus = lies(verfasser, empfang, alterStein(K), alterStein(D));
  assert.deepEqual(aus.filter((e) => e.nachricht.geloescht !== true), []);
  assert.deepEqual(aus.map((e) => e.nachricht.autor), ['', '']);
});
