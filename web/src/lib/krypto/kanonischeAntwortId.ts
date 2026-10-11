/**
 * Uebersetzt eine Antwort-Zielangabe von der LOKALEN Nachrichten-ID (wie sie
 * der Antwortende gerade in seinem eigenen Nachrichtenbestand sieht) in die
 * GERAETEUEBERGREIFENDE Kennung, die in die verschluesselte Nutzlast
 * eingebettet wird (s. `nachrichtNutzlast.ts`-Modulkopf).
 *
 * Der Grund fuer die Uebersetzung: bei einer Ende-zu-Ende-verschluesselten DM
 * hat dieselbe Nachricht auf Absender- und Empfaenger-Geraet VERSCHIEDENE
 * lokale IDs (Absender: selbst gewaehlte ID; Empfaenger: die
 * Postfach-Zustellungs-Kennung, s. `empfangen.ts`-Modulkopf). Ohne
 * Uebersetzung faende die Gegenseite den Zitat-Bezug beim Nachschlagen nicht
 * — sie kennt nur ihre EIGENE lokale ID fuer diese Nachricht.
 *
 * `krypto_id` (falls am Zielobjekt gesetzt) ist die vom URSPRUENGLICHEN Autor
 * gewaehlte, geraeteuebergreifende ID (bei einer eigenen gesendeten
 * Nachricht gleich ihrer lokalen ID). Fehlt sie (eigene Nachricht aus der
 * Zeit vor dem 2026-10-13 — dort ist die lokale ID schon die kanonische —
 * oder ein unbekanntes/nicht gefundenes Ziel, z. B. eine Klartext-Nachricht
 * mit echter Server-ID), gilt die uebergebene lokale ID unveraendert als
 * kanonische Form.
 *
 * Importfrei (bis auf den erweiterungspflichtigen Relativpfad unten), damit
 * Nodes eingebauter Testläufer die Datei ohne Bundler prüft (s. CLAUDE.md
 * „Die Falle"). Die Regel „`krypto_id`, sonst die eigene ID" steht einmal, in
 * `verlauf/identitaet.ts`.
 */
import { kanonischeId } from '../verlauf/identitaet.ts';

export function kanonischeAntwortId(
  replyToId: string | null,
  nachrichten: ReadonlyArray<{ id: string; krypto_id?: string }>
): string | null {
  if (replyToId === null) return null;
  const ziel = nachrichten.find((n) => n.id === replyToId);
  return kanonischeId(replyToId, ziel?.krypto_id);
}
