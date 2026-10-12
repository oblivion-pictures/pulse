/**
 * Was eine Löschung außer dem Grabstein noch mitnimmt: die Anhang-Bytes auf
 * diesem Gerät und die Anhang-Dateien in der eigenen Sicherung. Hier stehen
 * die Regeln, ausgeführt werden sie in `loeschen.ts`.
 *
 * **Die Anhang-ID wählt der Absender frei** (Gegenprüfung 2026-10-12,
 * Fund 2). Bis hierher nahm jede Löschung die Anhänge des gelöschten Satzes
 * mit, Bytes und Laufwerk-Datei, ohne zu fragen, wessen Anhänge das sind. Bob
 * kennt die ID jedes Bildes, das ich ihm geschickt habe. Er lieferte eine
 * Archiv-Zeile mit dieser ID und eine Grabstein-Zeile dazu ein, und seine
 * eigene, gebundene Löschung räumte mein Bild von meinem Gerät und aus meiner
 * Sicherung. Zwei Regeln dagegen:
 *
 *   - Bytes gehen nur, wenn kein anderer sichtbarer Satz dieselbe Anhang-ID
 *     trägt (`dbAnhaenge.ts::anhaengeVerwaistLoeschen`, in derselben
 *     Transaktion geprüft).
 *   - Die Laufwerk-Datei geht zusätzlich nur, wenn der gelöschte Satz vom
 *     eigenen Konto stammt (`laufwerkDateien`). Gespiegelt wird ohnehin nur
 *     Eigenes (`sicherung/anhaengeSpiegeln.ts`), eine fremde Löschung hat an
 *     der eigenen Sicherung nichts zu räumen.
 *
 * **Bekannte Lücke, dokumentiert statt behoben** (Gegenprüfung 2026-10-12,
 * R5, niedrig, Datenschutz). Die erste Regel hat eine Kehrseite: ein FREMDER
 * sichtbarer Satz mit meiner Anhang-ID hält bei meiner Löschung meine Bytes
 * fest, und mit ihnen die Laufwerk-Datei, denn `laufwerkDateien` nimmt nur,
 * was verwaist ist. Bob braucht dafür nur einen Satz mit der ID meines
 * Bildes, eine Archiv-Zeile oder eine eigene Nachricht, und lässt ihn stehen.
 * Lösche ich mein Bild, bleiben die Bytes auf diesem Gerät, bis Bobs Satz
 * geht. Die Datei in meiner Sicherung bleibt für immer: geht Bobs Satz
 * später, räumt seine Löschung die Bytes (`anhangKandidaten`), die
 * Laufwerk-Datei aber nicht, denn sein Satz ist nicht meiner, und die Folgen
 * meiner eigenen Löschung sind längst gelaufen. Verloren geht dabei nichts,
 * aber meine Löschung löscht nicht alles. Beheben hieße, sich die
 * Laufwerk-Dateien einer eigenen Löschung zu merken, bis kein sichtbarer Satz
 * sie mehr trägt, oder eine Anhang-ID an ihren Autor zu binden.
 *
 * Importfrei bis auf den `.ts`-Pfad (Nodes Testläufer).
 */
import { satzAnhangIds } from './satz.ts';
import { istUngeprueft } from './herkunft.ts';

/** Der Ausschnitt eines gelöschten Satzes, den die Regeln lesen. */
type GeloeschterSatz = { autorId: string; anhaenge?: unknown[]; ungeprueft?: true };

/** Die Anhang-IDs, deren Bytes die Löschung dieser Sätze mitnehmen darf,
 *  ohne Doppel. Nur Kandidaten: gelöscht wird erst, wenn kein sichtbarer Satz
 *  sie mehr trägt. Ein ungeprüfter Satz (`herkunft.ts`) gibt nichts frei:
 *  seine Anhang-Liste hat ein Fremder geschrieben, auch wenn der Satz einen
 *  anderen Autor nennt (Fund 4). */
export function anhangKandidaten(markiert: readonly GeloeschterSatz[]): string[] {
  const geprueft = markiert.filter((satz) => !istUngeprueft(satz));
  return [...new Set(geprueft.flatMap((satz) => satzAnhangIds(satz)))];
}

/** Die Anhang-Dateien in der eigenen Sicherung, die die Löschung DIESES
 *  Satzes mitnimmt: nur bei einem eigenen, geprüften Satz, und nur, was kein
 *  sichtbarer Satz mehr trägt (`verwaist`). */
export function laufwerkDateien(
  satz: GeloeschterSatz,
  kontoId: string,
  verwaist: ReadonlySet<string>
): string[] {
  if (satz.autorId !== kontoId || istUngeprueft(satz)) return [];
  return satzAnhangIds(satz).filter((id) => verwaist.has(id));
}
