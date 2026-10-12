import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zyklusAuswerten, type ZyklusWege } from '../src/lib/krypto/zyklusAuswerten.ts';
import { trifftFrame } from '../src/lib/krypto/loeschZiel.ts';
import type { Message, ReactionAggregate } from '../src/lib/api/types';
import type { ZustellungOffenErgebnis } from '../src/lib/krypto/zustellungOeffnen';

// Der Abholzyklus (`krypto/empfangen.ts`) über `zyklusAuswerten` — mit den
// ECHTEN Aufrufen in Verlauf und Anzeige, nur die Wege selbst sind
// nachgebildet. Bis 2026-10-12 prüften die Tests der Autor-Bindung nur die
// Zielauflösung (`loeschZiel.ts`) und wandten sie selbst an; ob der
// Empfangsweg den Absender übergibt und den Rückfall auf die Frame-ID
// wirklich nicht mehr hat, sah keiner (Gegenprüfung, Fund 9).

const ICH = 'ich';
const PARTNER = 'partner';
const KANAL = 'k1';

function nachricht(id: string, felder: Partial<Message> = {}): Message {
  return {
    id,
    channel_id: KANAL,
    author_id: PARTNER,
    content: `text ${id}`,
    nonce: null,
    created_at: '2026-10-12T00:00:00Z',
    verschluesselt: true,
    ...felder
  };
}

type Satz = { id: string; kryptoId?: string; autorId: string };

/** Ein nachgebildeter Verlauf (lokale Sätze) und eine Anzeige, die jeden
 *  Aufruf mitschreibt. `ablegen` legt die Nachrichten dort ab, wo der echte
 *  Weg sie ablegt — unter ihrer ID, mit `krypto_id` als Kennung. */
function wege(start: { verlauf?: Satz[]; geladen?: Message[]; fehlschlag?: string } = {}) {
  const verlauf: Satz[] = [...(start.verlauf ?? [])];
  const aufrufe: string[] = [];
  const w: ZyklusWege & { aufrufe: string[]; verlauf: Satz[] } = {
    aufrufe,
    verlauf,
    async ablegen(kanalId, nachrichten) {
      aufrufe.push(`ablegen ${kanalId} ${nachrichten.map((n) => n.id).join(',')}`);
      if (kanalId === start.fehlschlag) throw new Error('voll');
      for (const n of nachrichten) verlauf.push({ id: n.id, kryptoId: n.krypto_id, autorId: n.author_id });
      return [];
    },
    meldeFehler: (err) => aufrufe.push(`fehler ${(err as Error).message}`),
    geladen: () => start.geladen ?? [],
    async imVerlauf(_kanal, frameId, autorId) {
      aufrufe.push(`imVerlauf ${frameId} ${autorId ?? 'ungebunden'}`);
      return verlauf.filter((s) => trifftFrame(frameId, s, autorId)).map((s) => s.id);
    },
    async gebundenLoeschen(_kanal, kennung, autorId) {
      aufrufe.push(`gebundenLoeschen ${kennung} ${autorId}`);
      return verlauf.filter((s) => trifftFrame(kennung, s, autorId)).map((s) => s.id);
    },
    async reaktionAnwenden(_kanal, id, autorId, emoji) {
      aufrufe.push(`reaktion ${id} ${autorId} ${emoji}`);
      return [{ emoji, count: 1, me: false }] as ReactionAggregate[];
    },
    async bearbeitungAnwenden(_kanal, id, inhalt) {
      aufrufe.push(`bearbeitung ${id} ${inhalt}`);
      return true;
    },
    anzeigeEntfernen: (_kanal, id) => aufrufe.push(`entfernen ${id}`),
    anzeigeReaktionen: () => {},
    anzeigeInhalt: () => {},
    anrufSchluessel: (anrufId) => aufrufe.push(`anruf ${anrufId}`),
    jetzt: () => '2026-10-12T01:00:00Z'
  };
  return w;
}

const neu = (n: Message): ZustellungOffenErgebnis => ({ art: 'neu', nachricht: n });
const loeschung = (id: string, nachrichtId: string, absenderUserId: string): ZustellungOffenErgebnis => ({
  art: 'loeschung',
  id,
  channelId: KANAL,
  nachrichtId,
  absenderUserId
});
const bearbeitung = (id: string, ziel: string, autorId: string, inhalt: string): ZustellungOffenErgebnis => ({
  art: 'bearbeitung',
  id,
  channelId: KANAL,
  autorId,
  ziel,
  inhalt
});

test('Fund 3: der Lösch-Frame im selben Zyklus wie seine Nachricht wirkt — erst ablegen, dann löschen', async () => {
  const w = wege();
  const erg = await zyklusAuswerten(
    [neu(nachricht('z1', { krypto_id: 'K' })), loeschung('z2', 'K', PARTNER)],
    w
  );
  assert.deepEqual(w.aufrufe, ['ablegen k1 z1', 'gebundenLoeschen K partner', 'entfernen z1']);
  // Nicht angezeigt, aber beides quittiert und für den Zustellstand geöffnet.
  assert.deepEqual(erg.anzuzeigen, []);
  assert.deepEqual(erg.geoeffnet.map((n) => n.id), ['z1']);
  assert.deepEqual(erg.quittierbar, ['z1', 'z2']);
});

test('Fund 3: eine Bearbeitung im selben Zyklus landet im Verlauf UND in der Anzeige-Fassung', async () => {
  const w = wege();
  const erg = await zyklusAuswerten(
    [
      neu(nachricht('z1', { krypto_id: 'K' })),
      bearbeitung('z2', 'K', PARTNER, 'erste Korrektur'),
      bearbeitung('z3', 'K', PARTNER, 'zweite Korrektur')
    ],
    w
  );
  assert.deepEqual(w.aufrufe, [
    'ablegen k1 z1',
    'imVerlauf K partner',
    'bearbeitung z1 erste Korrektur',
    'imVerlauf K partner',
    'bearbeitung z1 zweite Korrektur'
  ]);
  // Der spätere Frame gewinnt.
  assert.equal(erg.anzuzeigen[0].content, 'zweite Korrektur');
  assert.equal(erg.anzuzeigen[0].edited_at, '2026-10-12T01:00:00Z');
});

test('Fund 9: ein fremder Lösch-Frame auf meine Nachricht löscht nichts — kein Rückfall auf die Frame-ID', async () => {
  const meine = nachricht('meine-1', { author_id: ICH });
  const w = wege({ verlauf: [{ id: 'meine-1', autorId: ICH }], geladen: [meine] });
  const erg = await zyklusAuswerten([loeschung('z9', 'meine-1', PARTNER)], w);
  // Gebunden an den Absender — und die Frame-ID wird nirgends als lokale ID
  // gelöscht, weder in der Anzeige noch im Verlauf.
  assert.deepEqual(w.aufrufe, ['gebundenLoeschen meine-1 partner']);
  // Quittiert wird trotzdem: der Frame bleibt sonst ewig im Postfach.
  assert.deepEqual(erg.quittierbar, ['z9']);
});

test('Fund 9: der Bearbeitungs-Frame übergibt seinen Absender, der Reaktions-Frame nicht', async () => {
  const w = wege({ verlauf: [{ id: 'meine-1', autorId: ICH }] });
  await zyklusAuswerten(
    [
      bearbeitung('z1', 'meine-1', PARTNER, 'untergeschoben'),
      {
        art: 'reaktion',
        id: 'z2',
        channelId: KANAL,
        autorId: PARTNER,
        ziel: 'meine-1',
        emoji: 'x',
        entfernen: false
      }
    ],
    w
  );
  // Die Bearbeitung des Partners findet meine Nachricht nicht; seine
  // Reaktion darauf schon.
  assert.deepEqual(w.aufrufe, [
    'imVerlauf meine-1 partner',
    'imVerlauf meine-1 ungebunden',
    'reaktion meine-1 partner x'
  ]);
});

test('ein Kanal, dessen Ablage scheitert, bleibt unquittiert — die anderen nicht', async () => {
  const w = wege({ fehlschlag: 'k2' });
  const erg = await zyklusAuswerten(
    [
      neu(nachricht('z1')),
      neu(nachricht('z2', { channel_id: 'k2' })),
      { art: 'schonAbgelegt', channelId: KANAL, id: 'z3' },
      { art: 'anrufSchluessel', id: 'z4', channelId: KANAL, autorId: PARTNER, anrufId: 'a1', schluessel: 's' }
    ],
    w
  );
  assert.deepEqual(erg.quittierbar, ['z1', 'z3', 'z4']);
  assert.ok(w.aufrufe.includes('fehler voll'));
  assert.ok(w.aufrufe.includes('anruf a1'));
});

test('was der Verlauf als Grabstein ablegt (Register), wird quittiert, aber nicht angezeigt', async () => {
  const w = wege();
  w.ablegen = async () => ['z1'];
  const erg = await zyklusAuswerten([neu(nachricht('z1')), neu(nachricht('z2'))], w);
  assert.deepEqual(erg.anzuzeigen.map((n) => n.id), ['z2']);
  assert.deepEqual(erg.quittierbar, ['z1', 'z2']);
});
