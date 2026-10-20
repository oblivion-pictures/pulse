import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zyklusAuswerten, type ZyklusWege } from '../src/lib/krypto/zyklusAuswerten.ts';
import { quittungVersuchen } from '../src/lib/krypto/postfachSchleife.ts';
import {
  wasserstandEntscheidung,
  wirksamerStand,
  type Wasserstand
} from '../src/lib/krypto/gruppe/wasserstand.ts';
import type { Message } from '../src/lib/api/types';
import type { ZustellungOffenErgebnis } from '../src/lib/krypto/zustellungOeffnen';

// Push-Bughunt 2026-10-21 — „wenn ich einen Chat offen habe, kommen manchmal
// Nachrichten nicht an“. Die echten Rechnungen des Abholzyklus, ohne
// IndexedDB und WASM (die Verdrahtung prüft `postfach-ankunft-verdrahtung`).

const KANAL = 'k1';

function nachricht(id: string, felder: Partial<Message> = {}): Message {
  return {
    id,
    channel_id: KANAL,
    author_id: 'partner',
    content: `text ${id}`,
    nonce: null,
    created_at: '2026-10-21T00:00:00Z',
    verschluesselt: true,
    ...felder
  };
}

function wege(
  start: {
    fehlschlag?: boolean;
    geladen?: Message[];
    abgelegt?: Record<string, Message | null>;
    leseFehler?: boolean;
  } = {}
) {
  const aufrufe: string[] = [];
  const w: ZyklusWege & { aufrufe: string[] } = {
    aufrufe,
    async ablegen(kanalId, nachrichten) {
      aufrufe.push(`ablegen ${kanalId} ${nachrichten.map((n) => n.id).join(',')}`);
      if (start.fehlschlag) throw new Error('Kanal unbekannt');
      return [];
    },
    meldeFehler: (err) => aufrufe.push(`fehler ${(err as Error).message}`),
    geladen: () => start.geladen ?? [],
    async imVerlauf() {
      return ['z1'];
    },
    async gebundenLoeschen() {
      return [];
    },
    async reaktionAnwenden() {
      return null;
    },
    async bearbeitungAnwenden() {
      if (start.fehlschlag) throw new Error('Verlauf verriegelt');
      return true;
    },
    anzeigeEntfernen: () => {},
    anzeigeReaktionen: () => {},
    anzeigeInhalt: () => {},
    anrufSchluessel: () => {},
    jetzt: () => '2026-10-21T01:00:00Z',
    async abgelegtLesen(kanalId, id) {
      aufrufe.push(`lesen ${kanalId} ${id}`);
      if (start.leseFehler) throw new Error('nicht lesbar');
      return start.abgelegt?.[id] ?? null;
    }
  };
  return w;
}

// --- Befund 1a: eine scheiternde Quittung kostet die Anzeige nicht ----------

test('Befund 1a: wirft die Quittung, meldet quittungVersuchen und kehrt normal zurück', async () => {
  const gemeldet: unknown[] = [];
  await quittungVersuchen(
    ['z1'],
    async () => {
      throw new Error('Netz weg');
    },
    (err) => gemeldet.push(err)
  );
  assert.equal(gemeldet.length, 1);
  assert.equal((gemeldet[0] as Error).message, 'Netz weg');
});

test('Befund 1a: ohne quittierbare IDs geht keine Anfrage hinaus', async () => {
  let gerufen = 0;
  await quittungVersuchen([], async () => void gerufen++, () => {});
  assert.equal(gerufen, 0);
  await quittungVersuchen(['z1', 'z2'], async (ids) => void (gerufen += ids.length), () => {});
  assert.equal(gerufen, 2);
});

// --- Befund 1b: eine schon abgelegte Zustellung erreicht die Anzeige --------

test('Befund 1b: schonAbgelegt liest den Satz und zeigt ihn an — quittiert wird wie bisher', async () => {
  const satz = nachricht('z1', { krypto_id: 'K' });
  const w = wege({ abgelegt: { z1: satz } });
  const erg = await zyklusAuswerten([{ art: 'schonAbgelegt', channelId: KANAL, id: 'z1' }], w);
  assert.deepEqual(erg.anzuzeigen, [satz]);
  assert.deepEqual(erg.quittierbar, ['z1']);
  // Kein frisch geöffneter Satz: der Zustellstand rechnet ihn nicht ein.
  assert.deepEqual(erg.geoeffnet, []);
});

test('Befund 1b: steht die Nachricht schon in der Anzeige (ID oder Identität), kein zweites Mal', async () => {
  const satz = nachricht('z1', { krypto_id: 'K' });
  for (const geladen of [[nachricht('z1')], [nachricht('archiv-7', { krypto_id: 'K' })]]) {
    const w = wege({ abgelegt: { z1: satz }, geladen });
    const erg = await zyklusAuswerten([{ art: 'schonAbgelegt', channelId: KANAL, id: 'z1' }], w);
    assert.deepEqual(erg.anzuzeigen, []);
    assert.deepEqual(erg.quittierbar, ['z1']);
  }
});

test('Befund 1b: ein gelöschter oder unlesbarer Satz wird nicht angezeigt, aber quittiert', async () => {
  const geloescht = wege({ abgelegt: { z1: nachricht('z1', { deleted_at: '2026-10-21T00:00:01Z' }) } });
  let erg = await zyklusAuswerten([{ art: 'schonAbgelegt', channelId: KANAL, id: 'z1' }], geloescht);
  assert.deepEqual(erg.anzuzeigen, []);
  assert.deepEqual(erg.quittierbar, ['z1']);

  const kaputt = wege({ leseFehler: true });
  erg = await zyklusAuswerten([{ art: 'schonAbgelegt', channelId: KANAL, id: 'z1' }], kaputt);
  assert.deepEqual(erg.anzuzeigen, []);
  assert.deepEqual(erg.quittierbar, ['z1']);
  assert.ok(kaputt.aufrufe.includes('fehler nicht lesbar'));
});

// --- Befund 2: der Wasserstand wandert erst mit der Ablage -----------------

test('Befund 2: scheitert die Ablage, wird der Wasserstand nicht festgeschrieben', async () => {
  const fest: string[] = [];
  const ergebnisse: ZustellungOffenErgebnis[] = [
    { art: 'neu', nachricht: nachricht('z1'), festschreiben: async () => void fest.push('z1') },
    { art: 'neu', nachricht: nachricht('z2'), festschreiben: async () => void fest.push('z2') }
  ];
  const erg = await zyklusAuswerten(ergebnisse, wege({ fehlschlag: true }));
  assert.deepEqual(fest, []);
  assert.deepEqual(erg.quittierbar, []);
});

test('Befund 2: gelingt die Ablage, wird festgeschrieben — ein Fehler dort hält die Quittung nicht auf', async () => {
  const fest: string[] = [];
  const w = wege();
  const erg = await zyklusAuswerten(
    [
      { art: 'neu', nachricht: nachricht('z1'), festschreiben: async () => void fest.push('z1') },
      {
        art: 'neu',
        nachricht: nachricht('z2'),
        festschreiben: async () => {
          throw new Error('Identitäts-DB voll');
        }
      }
    ],
    w
  );
  assert.deepEqual(fest, ['z1']);
  assert.deepEqual(erg.quittierbar, ['z1', 'z2']);
  assert.ok(w.aufrufe.includes('fehler Identitäts-DB voll'));
});

test('Befund 2: ein Frame schreibt seinen Wasserstand nur fest, wenn er angewandt wurde', async () => {
  const frame = (fest: string[]): ZustellungOffenErgebnis => ({
    art: 'bearbeitung',
    id: 'z5',
    channelId: KANAL,
    autorId: 'partner',
    ziel: 'K',
    inhalt: 'neu',
    festschreiben: async () => void fest.push('z5')
  });
  const ok: string[] = [];
  await zyklusAuswerten([frame(ok)], wege());
  assert.deepEqual(ok, ['z5']);
  const gescheitert: string[] = [];
  const erg = await zyklusAuswerten([frame(gescheitert)], wege({ fehlschlag: true }));
  assert.deepEqual(gescheitert, []);
  assert.deepEqual(erg.quittierbar, []);
});

test('Befund 2: zwei Nachrichten derselben Sitzung, Ablage scheitert — beide kommen im nächsten Zyklus durch', () => {
  // Zyklus 1: A (Zähler 5) und B (Zähler 6) werden geöffnet und nur
  // VORGEMERKT; die Ablage scheitert, festgeschrieben wird nichts.
  const gespeichert: Wasserstand | null = null;
  let vorgemerkt: Wasserstand | undefined;
  assert.equal(wasserstandEntscheidung(wirksamerStand(gespeichert, vorgemerkt), 5, 'A'), 'ok');
  vorgemerkt = { zaehler: 5, zustellung: 'A' };
  assert.equal(wasserstandEntscheidung(wirksamerStand(gespeichert, vorgemerkt), 6, 'B'), 'ok');
  vorgemerkt = { zaehler: 6, zustellung: 'B' };
  // Ein Wiedereinspiel von A unter neuer ID im SELBEN Zyklus bleibt erkannt.
  assert.equal(
    wasserstandEntscheidung(wirksamerStand(gespeichert, vorgemerkt), 5, 'A-kopie'),
    'wiedereinspiel'
  );
  // Zyklus 2: die Vormerkung ist weg, der gespeicherte Stand unverändert —
  // A ist KEIN Wiedereinspiel mehr (bis hierhin: Stand 6/B, A verworfen).
  assert.equal(wasserstandEntscheidung(wirksamerStand(gespeichert, undefined), 5, 'A'), 'ok');
});

test('Befund 2: der wirksame Stand ist der höhere von gespeichert und vorgemerkt', () => {
  const alt: Wasserstand = { zaehler: 9, zustellung: 'x' };
  const neu: Wasserstand = { zaehler: 4, zustellung: 'y' };
  assert.equal(wirksamerStand(alt, neu), alt);
  assert.equal(wirksamerStand(neu, alt), alt);
  assert.equal(wirksamerStand(null, neu), neu);
  assert.equal(wirksamerStand(alt, undefined), alt);
  assert.equal(wirksamerStand(null, undefined), null);
});
