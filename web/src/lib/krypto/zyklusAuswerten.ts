/**
 * Wertet die geöffneten Zustellungen EINES Abholzyklus aus
 * (`empfangen.ts::postfachZyklus`): Nachrichten ablegen, DANACH die
 * Aktions-Frames anwenden (Löschen, Bearbeiten, Reagieren), und sagen, was
 * quittiert werden darf und was angezeigt wird.
 *
 * **Die Reihenfolge ist der Grund für diese Datei** (Gegenprüfung
 * 2026-10-12, Fund 3). Das Postfach liefert nach Zustellungs-ID
 * (`routes/postfach_abholen.py`), eine Nachricht also VOR ihrem Lösch- oder
 * Bearbeitungs-Frame. Abgelegt wurden die Nachrichten aber erst nach der
 * Schleife, die Frames dagegen in ihr — ein Frame im selben Zyklus wie seine
 * Nachricht fand sie noch nicht, wurde quittiert und war verloren. Die
 * Nachricht stand danach unbearbeitet bzw. ungelöscht da. Der Kommentar dort
 * behauptete das Gegenteil („same-cycle ist die Reihenfolge garantiert").
 * Jetzt: erst alles ablegen, dann die Frames in ihrer Ankunftsreihenfolge.
 * Was sie an Nachrichten DESSELBEN Zyklus ändern, ziehen sie auch an deren
 * Anzeige-Fassung nach — die Anzeige übernimmt sie erst nach diesem Zyklus
 * (`ws/handlers/chat.ts`), ein Nachziehen dort liefe ins Leere.
 *
 * Ein Lösch-Frame trägt seine Löschung zusätzlich ins Grabstein-Register ein
 * (`verlauf/grabsteinRegister.ts`), auch ohne Treffer: kommt die Nachricht
 * erst in einem späteren Zyklus, landet sie dort als Grabstein.
 *
 * **Ein Frame wird nur quittiert, wenn seine Anwendung gelang** (Gegenprüfung
 * 2026-10-12, R3). Die Wege werfen bei einem Fehlschlag, statt ihn als „kein
 * Ziel" zu tarnen; bis dahin quittierte der Zyklus einen Frame auch dann, wenn
 * der Verlauf gar nicht erreichbar war (ein anderer Tab hatte seine Fassung
 * angehoben), und die Löschung oder Bearbeitung war verloren. Liegen bleibt
 * er dann für den nächsten Zyklus: eine Gruppen-Zustellung lässt sich erneut
 * öffnen, solange keine spätere derselben Sitzung den Wasserstand
 * weitergeschoben hat (`gruppe/wasserstand.ts`), ein Olm-Umschlag nicht mehr —
 * dessen Sitzung ist schon weitergedreht. Den häufigsten Fall, den Riegel nach
 * einem Fassungswechsel (`verlauf/verbindung.ts`), fangen Zyklus und
 * `zustellungOeffnen.ts` schon vor dem Entschlüsseln ab.
 *
 * Importfrei bis auf `.ts`-Pfade und Typen — die Wege kommen als Argument
 * (`ZyklusWege`), damit Nodes Testläufer den echten Ablauf prüft
 * (`test/krypto-zyklusAuswerten.test.ts`).
 */
import type { Message, ReactionAggregate } from '../api/types';
import type { ZustellungOffenErgebnis } from './zustellungOeffnen';
import { frameZiele, lokaleIdsFuerLoeschung } from './loeschZiel.ts';
import { quittierbareIds, type KanalGruppe } from './quittierbareIds.ts';

/** Was die Auswertung an Verlauf, Anzeige und Anruf-Store braucht. Die Wege
 *  in den Verlauf werfen bei einem Fehlschlag (s. Modulkopf). */
export interface ZyklusWege {
  /** Legt die Nachrichten eines Kanals ab (Anhänge vorher). Wirft bei einem
   *  Fehlschlag; Ergebnis: die IDs, die als Grabstein abgelegt wurden. */
  ablegen(kanalId: string, nachrichten: Message[]): Promise<string[]>;
  meldeFehler(err: unknown): void;
  /** Die geladene Anzeige eines Kanals. */
  geladen(kanalId: string): ReadonlyArray<{ id: string; krypto_id?: string; author_id?: string }>;
  /** Die lokalen IDs, die ein Frame im Verlauf trifft (`verlaufLokaleIdsFuerFramePflicht`). */
  imVerlauf(kanalId: string, frameId: string, autorId?: string): Promise<string[]>;
  /** Gebundene Löschung samt Register (`verlaufGebundenGeloescht`). */
  gebundenLoeschen(kanalId: string, kennung: string, autorId: string): Promise<string[]>;
  reaktionAnwenden(
    kanalId: string,
    lokaleId: string,
    autorId: string,
    emoji: string,
    entfernen: boolean
  ): Promise<ReactionAggregate[] | null>;
  bearbeitungAnwenden(
    kanalId: string,
    lokaleId: string,
    inhalt: string,
    am: string
  ): Promise<boolean>;
  anzeigeEntfernen(kanalId: string, lokaleId: string): void;
  anzeigeReaktionen(kanalId: string, lokaleId: string, reaktionen: ReactionAggregate[]): void;
  anzeigeInhalt(kanalId: string, lokaleId: string, inhalt: string, am: string): void;
  anrufSchluessel(anrufId: string, schluessel: string): void;
  jetzt(): string;
}

export interface ZyklusErgebnis {
  /** Alle frisch geöffneten Nachrichten — für die Zustellstände. */
  geoeffnet: Message[];
  /** Was davon angezeigt wird: ohne Gelöschte, mit den Änderungen der Frames. */
  anzuzeigen: Message[];
  /** Die Zustellungs-IDs, die quittiert werden dürfen. */
  quittierbar: string[];
}

type Aktion = Extract<
  NonNullable<ZustellungOffenErgebnis>,
  { art: 'loeschung' | 'reaktion' | 'bearbeitung' }
>;

/** Was dieser Zyklus an einzelnen lokalen IDs geändert hat. */
interface Wirkung {
  /** Die Grabsteine, die die Ablage meldet (Register), plus die Löschungen
   *  der Frames. */
  geloescht: Set<string>;
  inhalt: Map<string, { inhalt: string; am: string }>;
  reaktionen: Map<string, ReactionAggregate[]>;
}

export async function zyklusAuswerten(
  ergebnisse: readonly ZustellungOffenErgebnis[],
  wege: ZyklusWege
): Promise<ZyklusErgebnis> {
  const geoeffnet: Message[] = [];
  const aktionen: Aktion[] = [];
  // Direkt quittierbar, ohne Ablage und ohne Anzeige: eine schon früher
  // abgelegte Zustellung (FIX 3, Runde 3), ein Gruppen-Verteilschlüssel
  // (Etappe G2), ein Anruf-Schlüssel und — nach ihrer Anwendung — die Frames.
  const ohneAblage: string[] = [];
  // `ablegen` nimmt einen Kanal je Aufruf — gleich nach Kanal gruppieren.
  const nachKanal = new Map<string, KanalGruppe>();

  for (const ergebnis of ergebnisse) {
    if (!ergebnis) continue;
    switch (ergebnis.art) {
      case 'loeschung':
      case 'reaktion':
      case 'bearbeitung':
        aktionen.push(ergebnis);
        break;
      case 'anrufSchluessel':
        // Nur im Anruf-Store merken (Arbeitsspeicher, nichts im Verlauf).
        wege.anrufSchluessel(ergebnis.anrufId, ergebnis.schluessel);
        ohneAblage.push(ergebnis.id);
        break;
      case 'schonAbgelegt':
      case 'ohneAblage':
        ohneAblage.push(ergebnis.id);
        break;
      case 'neu': {
        const nachricht = ergebnis.nachricht;
        geoeffnet.push(nachricht);
        const gruppe = nachKanal.get(nachricht.channel_id);
        if (gruppe) {
          gruppe.nachrichten.push(nachricht);
          gruppe.ids.push(nachricht.id);
        } else {
          nachKanal.set(nachricht.channel_id, { nachrichten: [nachricht], ids: [nachricht.id] });
        }
      }
    }
  }

  // ERST ablegen — quittiert wird je Kanal nur, was sicher liegt.
  const wirkung: Wirkung = { geloescht: new Set(), inhalt: new Map(), reaktionen: new Map() };
  const abgelegt = await quittierbareIds(
    nachKanal,
    async (kanalId, nachrichten) => {
      const grabsteine = await wege.ablegen(kanalId, nachrichten as Message[]);
      for (const id of grabsteine) wirkung.geloescht.add(id);
    },
    wege.meldeFehler
  );

  // DANN die Frames, in ihrer Ankunftsreihenfolge. Ein Frame ohne Ziel wird
  // trotzdem quittiert: seine Nachricht ist hier nie angekommen — und kommt
  // sie später, hält das Register eine Löschung fest; eine Bearbeitung oder
  // Reaktion auf eine Nachricht, die dieses Gerät nie hatte, geht verloren.
  // Ein Frame, dessen Anwendung scheitert, bleibt liegen (s. Modulkopf).
  for (const aktion of aktionen) {
    try {
      await aktionAnwenden(aktion, wege, wirkung);
      ohneAblage.push(aktion.id);
    } catch (err) {
      wege.meldeFehler(err);
    }
  }

  return {
    geoeffnet,
    anzuzeigen: anzeigeFassungen(geoeffnet, wirkung),
    quittierbar: [...abgelegt, ...ohneAblage]
  };
}

async function aktionAnwenden(aktion: Aktion, wege: ZyklusWege, wirkung: Wirkung): Promise<void> {
  const kanal = aktion.channelId;
  if (aktion.art === 'loeschung') {
    // Gebunden an den Absender: nur der Verfasser löscht seine Sätze
    // (`loeschZiel.ts`). Kein Rückfall auf die Frame-ID als lokale ID — so
    // löschte bis 2026-10-11 ein fremder Frame die eigene Nachricht des
    // Empfängers (Begründung in `loeschZiel.ts::frameZiele`).
    const { nachrichtId, absenderUserId } = aktion;
    const ziele = new Set([
      ...lokaleIdsFuerLoeschung(nachrichtId, wege.geladen(kanal), absenderUserId),
      ...(await wege.gebundenLoeschen(kanal, nachrichtId, absenderUserId))
    ]);
    for (const id of ziele) {
      wege.anzeigeEntfernen(kanal, id);
      wirkung.geloescht.add(id);
    }
    return;
  }
  if (aktion.art === 'reaktion') {
    // Ungebunden: reagieren darf jeder auf jede Nachricht, und eine Reaktion
    // ändert die Nachricht selbst nicht.
    const ziele = await frameZiele(aktion.ziel, wege.geladen(kanal), () =>
      wege.imVerlauf(kanal, aktion.ziel)
    );
    for (const id of ziele) {
      const reaktionen = await wege.reaktionAnwenden(
        kanal,
        id,
        aktion.autorId,
        aktion.emoji,
        aktion.entfernen
      );
      if (!reaktionen) continue;
      wege.anzeigeReaktionen(kanal, id, reaktionen);
      wirkung.reaktionen.set(id, reaktionen);
    }
    return;
  }
  // Bearbeitung, gebunden an den Absender wie das Löschen (2026-10-12): ohne
  // die Bindung schrieb der Gesprächspartner den Text MEINER eigenen
  // Nachricht auf meinem Gerät um. Zwei Frames auf dasselbe Ziel: der
  // spätere gewinnt — im selben Zyklus durch die Schleife, über Zyklen durch
  // die Zustellungs-ID; ein `bearbeitetAm`-Vergleich wäre der Ausbau, falls
  // je überholende Frames beobachtet werden.
  const ziele = await frameZiele(
    aktion.ziel,
    wege.geladen(kanal),
    () => wege.imVerlauf(kanal, aktion.ziel, aktion.autorId),
    aktion.autorId
  );
  const am = wege.jetzt();
  for (const id of ziele) {
    if (!(await wege.bearbeitungAnwenden(kanal, id, aktion.inhalt, am))) continue;
    wege.anzeigeInhalt(kanal, id, aktion.inhalt, am);
    wirkung.inhalt.set(id, { inhalt: aktion.inhalt, am });
  }
}

/** Die Anzeige-Fassung der geöffneten Nachrichten: ohne die gelöschten, mit
 *  Text und Reaktionen, die ein Frame desselben Zyklus gesetzt hat. */
function anzeigeFassungen(geoeffnet: Message[], wirkung: Wirkung): Message[] {
  return geoeffnet
    .filter((n) => !wirkung.geloescht.has(n.id))
    .map((n) => {
      const bearbeitet = wirkung.inhalt.get(n.id);
      const reaktionen = wirkung.reaktionen.get(n.id);
      if (!bearbeitet && !reaktionen) return n;
      return {
        ...n,
        ...(bearbeitet ? { content: bearbeitet.inhalt, edited_at: bearbeitet.am } : {}),
        ...(reaktionen ? { reactions: reaktionen } : {})
      };
    });
}
