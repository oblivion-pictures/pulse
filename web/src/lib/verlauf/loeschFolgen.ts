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
 * Importfrei bis auf den `.ts`-Pfad (Nodes Testläufer).
 */
import { satzAnhangIds } from './satz.ts';

/** Der Ausschnitt eines gelöschten Satzes, den die Regeln lesen. */
type GeloeschterSatz = { autorId: string; anhaenge?: unknown[] };

/** Die Anhang-IDs, deren Bytes die Löschung dieser Sätze mitnehmen darf,
 *  ohne Doppel. Nur Kandidaten: gelöscht wird erst, wenn kein sichtbarer Satz
 *  sie mehr trägt. */
export function anhangKandidaten(markiert: readonly GeloeschterSatz[]): string[] {
  return [...new Set(markiert.flatMap((satz) => satzAnhangIds(satz)))];
}

/** Die Anhang-Dateien in der eigenen Sicherung, die die Löschung DIESES
 *  Satzes mitnimmt: nur bei einem eigenen Satz, und nur, was kein sichtbarer
 *  Satz mehr trägt (`verwaist`). */
export function laufwerkDateien(
  satz: GeloeschterSatz,
  kontoId: string,
  verwaist: ReadonlySet<string>
): string[] {
  if (satz.autorId !== kontoId) return [];
  return satzAnhangIds(satz).filter((id) => verwaist.has(id));
}
