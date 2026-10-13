/**
 * Aktions-Frames (Reaktion, Bearbeitung) im lokalen Verlauf anwenden, und die
 * Sätze finden, die ein Frame trifft. Aus `index.ts` herausgelöst
 * (2026-10-12), als jede dieser Funktionen eine zweite Form bekam; `index.ts`
 * reicht alle durch.
 *
 * **Zwei Formen je Weg** (Gegenprüfung 2026-10-12, R3):
 *
 *   - die `…Pflicht`-Form wirft bei einem Fehlschlag. Der Postfach-Zyklus
 *     (`krypto/empfangen.ts`) nimmt sie, denn er darf einen Frame nur
 *     quittieren, wenn seine Anwendung gelang (`krypto/zyklusAuswerten.ts`).
 *     Bis dahin sah ein nicht erreichbarer Verlauf dort aus wie „kein Ziel",
 *     und der Frame wurde quittiert und war verloren.
 *   - die gewohnte Form wirft nie: sie meldet den Fehlschlag bei
 *     `verlaufZustand` und gibt den leeren Wert zurück. Für die eigenen
 *     Aktionen (`components/chat/cloudNachrichtAktionen.ts`), deren Frame
 *     schon zugestellt ist, wenn sie lokal nachziehen.
 *
 * Die Frame-Suche (`verlaufLokaleIdsFuerFramePflicht`) gibt es nur in der
 * werfenden Form; die andere hatte keinen Aufrufer und ist entfallen.
 *
 * Ein lokal nicht geführter Kanal und ein fehlendes Konto sind in beiden
 * Formen kein Fehler, sondern „nichts zu tun" — wie bisher.
 */
import { sortierSchluessel } from './satz';
import { verlaufSatzUmschreiben, verlaufSatzIdsFuerFrame } from './db';
import { aktuellesKonto } from './konto';
import { verlaufZustand } from './zustand.svelte';
import { istLokalerKanal } from './kanalArt';
import { verlaufArchivBearbeitungen } from './dbArchivBearbeitung';
import type { ArchivBearbeitung } from './archivBearbeitung';
import {
  reaktionAnwenden,
  reaktionenZuAggregat,
  type ReaktionsAggregat
} from '../krypto/reaktionen';

/** Die gewohnte Form zu einer `…Pflicht`-Form: ein Fehlschlag meldet sich
 *  bei `verlaufZustand`, zurück kommt `ersatz`. */
function gemeldet<T>(arbeit: Promise<T>, ersatz: T): Promise<T> {
  return arbeit.catch((err: unknown) => {
    verlaufZustand.melde(err);
    return ersatz;
  });
}

/**
 * Wendet EINE Reaktion (eigene oder per Umschlag empfangene) auf den Satz
 * `nachrichtId` an — `nachrichtId` ist die LOKALE ID; eine kanonische ID aus
 * einem Umschlag loest der Aufrufer vorher auf
 * (`verlaufLokaleIdsFuerFramePflicht`, s. `krypto/empfangen.ts`). Gibt die neue Anzeige-Form zurueck, oder `null`,
 * wenn nichts geschrieben wurde: kein solcher Satz, Grabstein, fremdes
 * Konto, oder der Umschlag aenderte nichts (doppelt angekommen, s.
 * `krypto/reaktionen.ts`). Wirft bei einem Fehlschlag (s. Modulkopf).
 */
export async function verlaufReaktionAnwendenPflicht(
  kanalId: string,
  nachrichtId: string,
  autorId: string,
  emoji: string,
  entfernen: boolean
): Promise<ReaktionsAggregat[] | null> {
  if (!istLokalerKanal(kanalId)) return null;
  const kontoId = aktuellesKonto();
  if (kontoId === null) return null;
  const schluessel = sortierSchluessel(kanalId, nachrichtId);
  const neu = await verlaufSatzUmschreiben(schluessel, kontoId, (satz) => {
    if (satz.geloescht) return null;
    const reaktionen = reaktionAnwenden(satz.reaktionen, autorId, emoji, entfernen);
    return reaktionen === satz.reaktionen ? null : { ...satz, reaktionen };
  });
  return neu ? reaktionenZuAggregat(neu.reaktionen, kontoId) : null;
}

/** Wie `verlaufReaktionAnwendenPflicht`, wirft aber nie — der Aufrufer laesst
 *  bei `null` die Anzeige, wie sie ist. */
export function verlaufReaktionAnwenden(
  kanalId: string,
  nachrichtId: string,
  autorId: string,
  emoji: string,
  entfernen: boolean
): Promise<ReaktionsAggregat[] | null> {
  return gemeldet(
    verlaufReaktionAnwendenPflicht(kanalId, nachrichtId, autorId, emoji, entfernen),
    null
  );
}

/** Setzt Text und Bearbeitungszeit des Satzes `nachrichtId` (LOKALE ID).
 *  `true`, wenn geschrieben wurde; ein Grabstein bleibt einer. Wirft bei
 *  einem Fehlschlag (s. Modulkopf). */
export async function verlaufBearbeitungAnwendenPflicht(
  kanalId: string,
  nachrichtId: string,
  inhalt: string,
  bearbeitetAm: string
): Promise<boolean> {
  if (!istLokalerKanal(kanalId)) return false;
  const kontoId = aktuellesKonto();
  if (kontoId === null) return false;
  const schluessel = sortierSchluessel(kanalId, nachrichtId);
  const neu = await verlaufSatzUmschreiben(schluessel, kontoId, (satz) =>
    satz.geloescht ? null : { ...satz, inhalt, bearbeitetAm }
  );
  return neu !== null;
}

/** Wie `verlaufBearbeitungAnwendenPflicht`, wirft aber nie. */
export function verlaufBearbeitungAnwenden(
  kanalId: string,
  nachrichtId: string,
  inhalt: string,
  bearbeitetAm: string
): Promise<boolean> {
  return gemeldet(
    verlaufBearbeitungAnwendenPflicht(kanalId, nachrichtId, inhalt, bearbeitetAm),
    false
  );
}

/**
 * Die lokalen IDs aller Sätze, die ein Frame mit `frameId` trifft — für den
 * Lösch-, Reaktions- und Bearbeitungs-Frame (`krypto/loeschZiel.ts`): die
 * Anzeige kennt nur die geladenen Nachrichten, der Verlauf auch die
 * älteren. `autorId` muss beim Lösch-Frame dessen Absender sein: es gilt
 * dieselbe Schranke wie in der Anzeige (`trifftFrame`), sonst löschte ein
 * Frame über den Verlauf genau das, was er über die geladene Liste nicht
 * darf. Leer heißt „kein solcher Satz auf diesem Gerät"; wirft bei einem
 * Fehlschlag (s. Modulkopf).
 */
export async function verlaufLokaleIdsFuerFramePflicht(
  kanalId: string,
  frameId: string,
  autorId?: string
): Promise<string[]> {
  if (!istLokalerKanal(kanalId)) return [];
  const kontoId = aktuellesKonto();
  if (kontoId === null) return [];
  return verlaufSatzIdsFuerFrame(kanalId, frameId, kontoId, autorId);
}


/** Die Bearbeitungs-Zeilen des Server-Archivs (`archivBearbeitung.ts`) auf
 *  die Sätze dieses Kontos im Kanal anwenden — sie ergänzen nur
 *  unbearbeitete Sätze ihres Autors. Gibt zurück, was umgeschrieben wurde,
 *  damit die Anzeige nachzieht; wirft nie (wie `verlaufErgaenzen`). */
export function verlaufArchivBearbeitungenAnwenden(
  kanalId: string,
  bearbeitungen: Map<string, ArchivBearbeitung>
): Promise<Array<{ id: string; inhalt: string; bearbeitetAm: string }>> {
  const kontoId = aktuellesKonto();
  if (!istLokalerKanal(kanalId) || kontoId === null) return Promise.resolve([]);
  return gemeldet(
    verlaufArchivBearbeitungen(kanalId, kontoId, bearbeitungen).then((saetze) =>
      saetze.map((s) => ({ id: s.nachrichtId, inhalt: s.inhalt, bearbeitetAm: s.bearbeitetAm ?? '' }))
    ),
    []
  );
}
