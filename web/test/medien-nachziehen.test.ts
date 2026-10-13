import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { medienNachziehen, zeileAusServerAnhang, type ServerAnhang } from '../src/lib/verlauf/medienNachzug.ts';
import {
  medienNeuesteZuerst,
  medienZeileDarfSchreiben,
  medienZeilenAusSatz
} from '../src/lib/verlauf/schema.ts';

const KONTO = 'konto-1';

/** Druckt eine Snowflake-artige id in eine Server-Zeile (verschlüsselt =
 *  NULL-Metadaten, genau wie `routes/meine_anhaenge.py` sie liefert). */
function zeile(id: string, overrides: Partial<ServerAnhang> = {}): ServerAnhang {
  return {
    id,
    channel_id: '77',
    filename: `bild-${id}.png`,
    mime: 'image/png',
    size: 1000,
    hat_thumb: true,
    erstellt_am: '2026-09-01T10:00:00Z',
    verschluesselt: false,
    laufwerk_verteilt: false,
    ...overrides
  };
}

/** Fake-Server: liefert die VORgesetzte Liste newest-first in Seiten der
 *  Groesse `limit`, merkt sich jeden Abruf mit seinem Cursor. */
function fakeServer(ids: string[], limit: number, abbruchBei?: string) {
  const aufrufe: (string | null)[] = [];
  const abrufen: string[][] = [];
  const abruf = async (before: string | null): Promise<ServerAnhang[]> => {
    aufrufe.push(before);
    if (abbruchBei !== undefined && before !== null && BigInt(before) <= BigInt(abbruchBei)) {
      // Server, der die Zusage bricht und auf der Stelle pedalt — fuer die
      // Cursor-Wache.
      return ids.slice(0, limit).map((id) => zeile(id));
    }
    const seite = ids.filter((id) => before === null || BigInt(id) < BigInt(before)).slice(0, limit);
    abrufen.push(seite);
    return seite.map((id) => zeile(id));
  };
  return { abruf, aufrufe };
}

describe('Medien-Nachzug', () => {
  it('blaettert newest-first mit EXKLUSIVEM Cursor bis zum Anfang durch', async () => {
    const ids = ['105', '104', '103', '102', '101', '100'];
    const server = fakeServer(ids, 2);
    const geschreiben: string[] = [];
    const bericht = await medienNachziehen(server.abruf, {
      kontoId: KONTO,
      limit: 2,
      liegtVor: async () => false,
      schreiben: async (zeilen) => {
        for (const z of zeilen) geschreiben.push(z.id);
      }
    });

    // Cursor = letzte gesehene id; die Seite dahinter beginnt STRENG darunter.
    assert.deepEqual(server.aufrufe, [null, '104', '102', '100']);
    assert.deepEqual(geschreiben, ids);
    assert.equal(bericht.nachgezogen, 6);
    assert.equal(bericht.ueberlappung, false);
    assert.equal(bericht.leergelaufen, true);
  });

  it('bricht am ERSTEN lokal bekannten Anhang ab und holt danach nichts mehr', async () => {
    const ids = ['105', '104', '103', '102', '101', '100'];
    const server = fakeServer(ids, 2);
    const geschreiben: string[] = [];
    const bericht = await medienNachziehen(server.abruf, {
      kontoId: KONTO,
      limit: 2,
      // 103 liegt bereits im Index (Seite 2, zweiter Eintrag)
      liegtVor: async (id) => id === '103',
      schreiben: async (zeilen) => {
        for (const z of zeilen) geschreiben.push(z.id);
      }
    });

    // Seite 1 (105,104) neu; auf Seite 2 ist 103 bekannt — die Überlappung
    // beendet den Lauf, 102 und alles Ältere gilt als lokal vorhanden,
    // Seite 3 wird nie angefragt.
    assert.deepEqual(geschreiben, ['105', '104']);
    assert.equal(server.aufrufe.length, 2);
    assert.equal(bericht.nachgezogen, 2);
    assert.equal(bericht.ueberlappung, true);
    assert.equal(bericht.leergelaufen, false);
  });

  it('hoert auf, wenn der Server seine Cursor-Zusage bricht (Endlos-Schleife)', async () => {
    const server = fakeServer(['105', '104'], 2, '999');
    const bericht = await medienNachziehen(server.abruf, {
      kontoId: KONTO,
      limit: 2,
      liegtVor: async () => false,
      schreiben: async () => {}
    });
    assert.equal(server.aufrufe.length, 2);
    assert.equal(bericht.nachgezogen, 2);
    assert.equal(bericht.leergelaufen, false);
  });

  it('verschluesselte Zeilen mit NULL-Metadaten landen mit kanalId/kontoId im Index', async () => {
    const roh = zeile('500', {
      channel_id: '777',
      filename: null,
      mime: null,
      hat_thumb: false,
      verschluesselt: true,
      laufwerk_verteilt: true
    });
    const zeile_ = zeileAusServerAnhang(roh, KONTO);

    assert.equal(zeile_.id, '500');
    assert.equal(zeile_.kanalId, '777');
    assert.equal(zeile_.kontoId, KONTO);
    // Der Endpunkt liefert nur eigene Uploads — der Autor ist das Konto.
    assert.equal(zeile_.autorId, KONTO);
    assert.equal(zeile_.dateiname, null);
    assert.equal(zeile_.mime, null);
    assert.equal(zeile_.verschluesselt, true);
    // Den Schluessel sieht der Server nie — nur lokale Saetze tragen ihn.
    assert.equal(zeile_.schluessel, null);
    assert.equal(zeile_.laufwerkVerteilt, true);

    // Und derselbe Weg durch die Schleife: die Zeile landet geschrieben.
    const abgeladen: typeof zeile_[] = [];
    const server = fakeServer(['500'], 50);
    await medienNachziehen(server.abruf, {
      kontoId: KONTO,
      liegtVor: async () => false,
      schreiben: async (zeilen) => {
        abgeladen.push(...zeilen);
      }
    });
    assert.equal(abgeladen.length, 1);
    assert.equal(abgeladen[0]!.kontoId, KONTO);
    assert.equal(abgeladen[0]!.kanalId, '77');
  });
});

describe('Medien-Index aus Satz (Zweit-Schreibweg von verlaufPutSaetze)', () => {
  const basis = {
    schluessel: '00000000000000000042:00000000000000001000',
    kanalId: '42',
    nachrichtId: '1000',
    autorId: 'nutzer-9',
    inhalt: '',
    erstelltAm: '2026-09-01T10:00:00Z',
    bearbeitetAm: null,
    geloescht: false,
    verschluesselt: true,
    antwortAufId: null,
    kryptoId: null,
    kontoId: KONTO
  };

  it('uebertraegt Anhaenge als Index-Zeilen mit Kanal, Konto, Autor und Schluessel', () => {
    const satz = {
      ...basis,
      anhaenge: [
        {
          id: '601',
          filename: 'geheim.png',
          mime: 'image/png',
          size: 42,
          verschluesselt: true,
          schluessel: 'SCHLUESSEL',
          thumb_schluessel: 'THUMB'
        },
        { id: '602', filename: 'lesbar.pdf', mime: 'application/pdf', size: 7, url: 'https://x', thumb_url: 'https://t' },
        { kaputt: true }, // ohne id — wird fail-closed uebersprungen
        // Keine Kennung — `medienLesen` sortiert mit `BigInt` (Fund 1, 2026-10-12).
        { id: '../x', filename: 'f', mime: 'image/png', size: 1 },
        null
      ]
    };
    const zeilen = medienZeilenAusSatz(satz);
    assert.equal(zeilen.length, 2);

    assert.equal(zeilen[0]!.id, '601');
    assert.equal(zeilen[0]!.kanalId, '42');
    assert.equal(zeilen[0]!.kontoId, KONTO);
    assert.equal(zeilen[0]!.autorId, 'nutzer-9');
    assert.equal(zeilen[0]!.erstelltAm, '2026-09-01T10:00:00Z');
    assert.equal(zeilen[0]!.dateiname, 'geheim.png');
    assert.equal(zeilen[0]!.verschluesselt, true);
    assert.equal(zeilen[0]!.hatThumb, true);
    assert.equal(zeilen[0]!.schluessel, 'SCHLUESSEL');

    assert.equal(zeilen[1]!.id, '602');
    assert.equal(zeilen[1]!.verschluesselt, false);
    assert.equal(zeilen[1]!.schluessel, null);
    assert.equal(zeilen[1]!.hatThumb, true);
  });

  it('Grabstein-Saetze liefern keine Index-Zeilen', () => {
    const satz = {
      ...basis,
      geloescht: true,
      anhaenge: [{ id: '601', filename: 'x', mime: 'text/plain', size: 1 }]
    };
    assert.deepEqual(medienZeilenAusSatz(satz), []);
  });
});

// Gegenprüfung 2026-10-12, R6: `medienLesen` sortierte mit `BigInt(id)`. Eine
// Altzeile mit der ID "x" warf mitten im Sortieren, und das Medien-Archiv
// blieb auf Dauer leer; eine lokal vergebene 19-stellige ID stand immer vorn.
describe('medienNeuesteZuerst', () => {
  it('überspringt Zeilen ohne gültige Kennung und ordnet nach der eingebetteten Zeit', () => {
    // Lokale ID: Date.now() = 1700000000000 (2023) + Zufall, numerisch größer
    // als die Snowflake, aber älter. Snowflake: 5 s nach dem Epoch (2026).
    const lokalAelter = '1700000000000123456';
    const serverNeuer = String(5000n * 4194304n);
    const serverAelter = String(1000n * 4194304n);
    const aus = medienNeuesteZuerst([
      { id: serverAelter },
      { id: 'x' },
      { id: lokalAelter },
      { id: '0123' },
      { id: serverNeuer }
    ]);
    assert.deepEqual(
      aus.map((z) => z.id),
      [serverNeuer, serverAelter, lokalAelter]
    );
  });
});

// Gegenprüfung 2026-10-14, V4: der Medien-Index ist nur nach der Anhang-ID
// geschlüsselt, und jeder Schreibweg legte seine Zeile blind ab. Wer die ID
// meines Bildes kannte, überschrieb meine Zeile mit seinem Autor, Namen und
// Schlüssel.
describe('V4: medienZeileDarfSchreiben', () => {
  const meine = { autorId: '100', kontoId: KONTO };
  it('ein freier Platz und die eigene Zeile dürfen beschrieben werden', () => {
    assert.equal(medienZeileDarfSchreiben(undefined, meine), true);
    assert.equal(medienZeileDarfSchreiben(meine, { ...meine }), true);
  });
  it('eine Zeile eines anderen Autors oder Kontos bleibt liegen', () => {
    assert.equal(medienZeileDarfSchreiben(meine, { autorId: '300', kontoId: KONTO }), false);
    assert.equal(medienZeileDarfSchreiben(meine, { autorId: '100', kontoId: 'konto-2' }), false);
  });
});
