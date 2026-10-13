/**
 * Bearbeitungs-Zeilen des Server-Archivs (main-Prüfbericht, Fund 5): ein
 * Frischgerät ohne Sicherung zeigte den Originaltext einer bearbeiteten
 * Nachricht, denn die Archiv-Zeile ist die Fassung beim Senden.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bearbeitungFuerSatz,
  bearbeitungenSammeln,
  type ArchivBearbeitung
} from '../src/lib/verlauf/archivBearbeitung.ts';
import { baueBearbeitungKlar, leseZeile } from '../src/lib/archiv/zeile.ts';

const K = '1760000000000123456';
const ALICE = '42';
const BOB = '7';

function satz(mit: Partial<Parameters<typeof bearbeitungFuerSatz>[0]> = {}) {
  return {
    nachrichtId: '420000000000000078',
    kryptoId: K,
    autorId: ALICE,
    inhalt: 'Original',
    bearbeitetAm: null as string | null,
    geloescht: false,
    ...mit
  };
}

function gesammelt(...liste: ArchivBearbeitung[]): Map<string, ArchivBearbeitung> {
  const m = new Map<string, ArchivBearbeitung>();
  bearbeitungenSammeln(m, liste);
  return m;
}

const b = (inhalt: string, am: string, autorId = ALICE, kennung = K): ArchivBearbeitung => ({
  autorId,
  kennung,
  inhalt,
  bearbeitetAm: am
});

test('Fund 5: die Bearbeitungs-Zeile des Autors setzt den Text eines unbearbeiteten Satzes', () => {
  const neu = bearbeitungFuerSatz(satz(), gesammelt(b('Neu', '2026-10-14T10:00:00.000Z')));
  assert.equal(neu?.inhalt, 'Neu');
  assert.equal(neu?.bearbeitetAm, '2026-10-14T10:00:00.000Z');
  // Auch über die eigene ID, wenn der Satz unter der Kennung liegt.
  const eigen = satz({ nachrichtId: K, kryptoId: null });
  assert.equal(bearbeitungFuerSatz(eigen, gesammelt(b('Neu', '2026-10-14T10:00:00.000Z')))?.inhalt, 'Neu');
});

test('Fund 5: sie trifft keinen Satz eines anderen Autors und keinen gelöschten', () => {
  assert.equal(bearbeitungFuerSatz(satz(), gesammelt(b('Bob', '2026-10-14T10:00:00.000Z', BOB))), null);
  assert.equal(bearbeitungFuerSatz(satz({ geloescht: true }), gesammelt(b('Neu', '2026-10-14T10:00:00.000Z'))), null);
});

test('Fund 5: sie ergänzt nur, ein bearbeiteter Satz bleibt', () => {
  const bearbeitet = satz({ inhalt: 'live', bearbeitetAm: '2026-10-14T09:00:00.000Z' });
  assert.equal(bearbeitungFuerSatz(bearbeitet, gesammelt(b('Neu', '2026-10-14T10:00:00.000Z'))), null);
});

test('Fund 5: unter mehreren Zeilen derselben Nachricht gilt die jüngste, in jeder Reihenfolge', () => {
  const alt = b('erste', '2026-10-14T10:00:00.000Z');
  const jung = b('zweite', '2026-10-14T11:00:00.000Z');
  for (const reihe of [[alt, jung], [jung, alt]]) {
    assert.equal(bearbeitungFuerSatz(satz(), gesammelt(...reihe))?.inhalt, 'zweite');
  }
});

test('Fund 5: die Zeile zählt nur von ihrem Autor und mit gültiger Kennung', () => {
  const roh = (kennung: string, autor = ALICE) =>
    new TextDecoder().decode(baueBearbeitungKlar(kennung, autor, 'Neu', '2026-10-14T10:00:00.000Z'));
  const von = (einlieferer: string | null) => ({ einlieferer, zeilenId: '420000000000000099', konto: ALICE });
  assert.deepEqual(leseZeile('999', roh(K), von(ALICE)), {
    art: 'bearbeitung',
    autorId: ALICE,
    kennung: K,
    inhalt: 'Neu',
    bearbeitetAm: '2026-10-14T10:00:00.000Z'
  });
  assert.equal(leseZeile('999', roh(K), von(BOB)), null);
  assert.equal(leseZeile('999', roh(K), von(null)), null);
  assert.equal(leseZeile('999', roh('x'), von(ALICE)), null);
  assert.equal(leseZeile('999', '{"e":"' + K + '","a":"42","t":7,"z":"2026"}', von(ALICE)), null);
});
