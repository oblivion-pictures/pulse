/**
 * Das Ergebnis von `zustellungOeffnen` — aus `zustellungOeffnen.ts`
 * herausgeloest (Push-Bughunt 2026-10-21), als die Datei ueber die
 * Groessen-Policy (PLAN.md §12.1) gewachsen war. Importfrei bis auf Typen,
 * damit `zyklusAuswerten.ts` und seine Tests es ohne den WASM-Kegel lesen.
 */
import type { Message } from '../api/types';

/** Schreibt den Wasserstand einer Gruppennachricht fest — erst NACH der
 *  gelungenen Ablage bzw. Anwendung (`zyklusAuswerten.ts`), s.
 *  `gruppe/wasserstand.ts::wirksamerStand`. Nur der Gruppenweg setzt es. */
export type Festschreiben = { festschreiben?: () => Promise<void> };

/** Ergebnis eines Oeffnungsversuchs:
 *  * `neu` — frisch entschluesselte Nachricht, muss noch abgelegt werden;
 *  * `schonAbgelegt` — war schon einmal entschluesselt und abgelegt, braucht
 *    nur noch die (bislang fehlgeschlagene) Quittung (Bughunt-Runde 3,
 *    FIX 3, s. `empfangen.ts`-Modulkopf);
 *  * `ohneAblage` — erfolgreich verarbeitet, aber es gibt nichts anzuzeigen
 *    und nichts abzulegen: ein Gruppen-Verteilschluessel (Etappe G2, s.
 *    `gruppe/empfangen.ts`). Er ist in dem Moment sicher verwahrt, in dem
 *    seine eingehende Sitzung in IndexedDB liegt — die Quittung darf also
 *    direkt folgen.
 *
 *  `festschreiben` (an `neu` und den Frames, nur aus dem Gruppenweg) s.
 *  `Festschreiben` oben.
 *
 *  `null`, wenn die Zustellung liegen bleiben muss. */
export type ZustellungOffenErgebnis =
  | ({ art: 'neu'; nachricht: Message } & Festschreiben)
  | { art: 'schonAbgelegt'; channelId: string; id: string }
  | { art: 'ohneAblage'; id: string }
  | ({
      art: 'loeschung';
      id: string;
      channelId: string;
      nachrichtId: string;
      /** Wer den Frame geschickt hat — nur seine eigenen Sätze darf er löschen
       *  (s. `loeschZiel.ts`). */
      absenderUserId: string;
    } & Festschreiben)
  /** Reaktions-Umschlag (P1.5): `ziel` ist die KANONISCHE ID der Nachricht,
   *  `autorId` der Sitzungs-Partner, der reagiert hat. Der Aufrufer wendet
   *  ihn lokal an und quittiert direkt — nichts abzulegen. */
  | ({
      art: 'reaktion';
      id: string;
      channelId: string;
      autorId: string;
      ziel: string;
      emoji: string;
      entfernen: boolean;
    } & Festschreiben)
  /** Bearbeitungs-Umschlag: `autorId` ist der Absender — nur seine eigenen
   *  Sätze darf er umschreiben (s. `empfangen.ts`). */
  | ({
      art: 'bearbeitung';
      id: string;
      channelId: string;
      autorId: string;
      ziel: string;
      inhalt: string;
    } & Festschreiben)
  /** Anruf-Schluessel-Frame (E2EE-Anrufe): `anrufId` + LiveKit-E2EE-Schluessel
   *  (`schluessel`, 32 Bytes base64). Der Aufrufer reicht beides an den
   *  Anruf-Store weiter und quittiert direkt — nichts abzulegen. */
  | {
      art: 'anrufSchluessel';
      id: string;
      channelId: string;
      autorId: string;
      anrufId: string;
      schluessel: string;
    }
  | null;
