/**
 * Welche LOKALEN Sätze ein Lösch-Frame trifft.
 *
 * Ein Lösch-Frame (`nachrichtNutzlast.ts::baueLoeschNutzlast`) trägt die
 * ID, unter der der ABSENDER die Nachricht kennt. Der Empfänger legt eine
 * empfangene Nachricht aber unter der Zustellungs-ID ab und hält die
 * Absender-ID nur als `krypto_id` daneben (`empfangeneNachricht.ts`, mit
 * Begründung). Wer den Frame-Wert direkt als lokale ID nimmt, findet auf
 * jedem Empfängergerät nichts — so geschehen am 2026-09-02: der Frame kam
 * an, wurde quittiert, und die Nachricht blieb bei der Gegenseite stehen.
 *
 * Getroffen ist ein Satz, wenn er die Frame-ID selbst trägt (eigenes Gerät
 * des Absenders, oder ein aus dem Archiv zurückgeholter Satz) ODER sie als
 * `krypto_id` führt (jedes empfangende Gerät). Beides zugleich kommt bei
 * mehreren Geräten desselben Kontos vor, deshalb eine Liste.
 *
 * **Und nur, wenn der Absender des Umschlags auch der Autor des Satzes ist.**
 * Ein Lösch-Frame trägt eine ID und sonst nichts; wer die ID kennt, kann ihn
 * bauen. Der Gesprächspartner kennt sie immer — er hat sie mit der Nachricht
 * bekommen und legt sie als `krypto_id` ab, während sie beim Verfasser die
 * lokale `id` IST. Ohne diesen Vergleich löscht ein angepasster Klient der
 * Gegenseite die eigenen Nachrichten des Empfängers auf dessen Gerät, samt
 * Grabstein im Archiv — und ein Archiv-Grabstein lässt sich nicht
 * zurücknehmen.
 *
 * Importfrei, damit Nodes eingebauter Testläufer die Datei ohne Bundler
 * prüft (s. CLAUDE.md „Die Falle").
 */

/** Ein lokaler Satz, wie ihn die beiden Suchwege kennen — die Anzeige
 *  (`Message`-Felder) und der Verlauf (`Satz`-Felder), hier auf einen
 *  gemeinsamen Nenner gebracht. */
export type FrameKandidat = { id: string; kryptoId?: string | null; autorId?: string };

/** Ein Satz der geladenen Anzeige, mit den `Message`-Feldnamen. */
type AnzeigeKandidat = { id: string; krypto_id?: string; author_id?: string };

/**
 * Ob ein Frame mit `frameId` diesen Satz trifft — die EINE Regel für die
 * geladene Anzeige (`lokaleIdsFuerLoeschung`) und den Verlaufs-Nachschlag
 * (`verlauf/db.ts::verlaufSatzIdsFuerFrame`). Zwei getrennte Fassungen
 * waren die Lücke, durch die der Rückfall in `empfangen.ts` lief: die eine
 * prüfte den Autor, die andere suchte nur über `kryptoId` und fand den
 * eigenen Satz des Verfassers (Frame-ID = lokale `id`) nie.
 *
 * Ohne `absenderUserId` sucht die Regel ohne Autor-Bindung — das dürfen nur
 * Aktions-Frames, die nichts löschen (Reaktion/Bearbeitung). Ohne bekannten
 * Autor am Satz trifft ein gebundener Frame nie: „im Zweifel löschen" ist bei
 * einem Vorgang ohne Rückweg die falsche Richtung.
 */
export function trifftFrame(
  frameId: string,
  satz: FrameKandidat,
  absenderUserId?: string
): boolean {
  if (satz.id !== frameId && satz.kryptoId !== frameId) return false;
  return absenderUserId === undefined || satz.autorId === absenderUserId;
}

export function lokaleIdsFuerLoeschung(
  frameId: string,
  kandidaten: ReadonlyArray<AnzeigeKandidat>,
  absenderUserId?: string
): string[] {
  const treffer = new Set<string>();
  for (const k of kandidaten) {
    const satz = { id: k.id, kryptoId: k.krypto_id, autorId: k.author_id };
    if (trifftFrame(frameId, satz, absenderUserId)) treffer.add(k.id);
  }
  return [...treffer];
}

/**
 * Alle lokalen Ziele eines Frames: die geladene Anzeige UND der Verlauf
 * (die Nachricht kann älter sein als das Geladene, und dieselbe Nachricht
 * kann lokal mehrfach liegen — Zustellungs-Kopie und Archiv-Kopie).
 * `imVerlauf` muss dieselbe Bindung anwenden (`trifftFrame`).
 *
 * **Leer heißt leer.** Bis 2026-10-11 stand im Aufrufer ein Rückfall „ohne
 * Treffer die Frame-ID selbst löschen" — mit der Begründung, eine ID
 * vergebe nur ihr Verfasser. Das stimmt, hilft aber nicht: der Partner
 * KENNT die ID jeder Nachricht, die ich ihm geschickt habe, und bei mir ist
 * sie die lokale `id`. Die Autor-Bindung wies seinen Frame ab, der Rückfall
 * löschte die Nachricht trotzdem — samt Grabstein in der Sicherung, der
 * sich nicht zurücknehmen lässt.
 */
export async function frameZiele(
  frameId: string,
  geladen: ReadonlyArray<AnzeigeKandidat>,
  imVerlauf: () => Promise<string[]>,
  absenderUserId?: string
): Promise<string[]> {
  const treffer = new Set(lokaleIdsFuerLoeschung(frameId, geladen, absenderUserId));
  for (const id of await imVerlauf()) treffer.add(id);
  return [...treffer];
}
