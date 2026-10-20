/**
 * Ein Laden nach einem `await` darf nichts verdrängen, was seither live in
 * den Kanal kam — die reine Rechnung hinter `messages.setInitial(…,
 * { liveBehalten: true })` (`stores/messages.svelte.ts`).
 *
 * **Der Fehler (Push-Bughunt, 2026-10-21):** „Wenn ich einen Chat offen
 * habe, kommen manchmal Nachrichten nicht an." Der Kanalwechsel leert die
 * Liste, liest den lokalen Verlauf (Momentaufnahme), fragt den Server und
 * ersetzt danach die GANZE Liste durch beides zusammen. Eine verschlüsselte
 * Nachricht, die nach der Momentaufnahme abgelegt und vor der Serverantwort
 * per `upsert` angezeigt wurde — die Postfach-Abholung beim Öffnen aus einer
 * Mitteilung ist genau dieser Fall —, steht in keiner der beiden Quellen (der
 * Server kennt keinen E2E-Klartext) und verschwand bis zum nächsten Öffnen.
 *
 * Behalten wird deshalb, was die aktuelle Liste hält und die geladene nicht
 * kennt, weder über die Id noch über die Identität (`listenKern.identitaet`,
 * Autor + Kennung; Regel in `verlauf/identitaet.ts`). Bei gleicher Id gewinnt
 * die geladene Fassung, wie bisher. **Vorläufige `tmp-`-Kopien fallen wie
 * bisher weg:** der lokale Verlauf legt Nachrichten ohne Nonce ab
 * (`verlauf/satz.ts`), eine behaltene `tmp-`-Kopie ließe sich deshalb nicht
 * gegen ihre schon abgelegte echte Fassung abgleichen, und das Echo (`upsert`
 * über die Nonce) setzte die echte Id dann ein zweites Mal in die Liste.
 * Ohne sie nimmt das Echo den normalen Weg und dedupt über die Id.
 *
 * Sortieren, Kappen und Grabsteine übernimmt `setInitial` danach wie für jede
 * Eingabe. Importfrei im Sinn der `pnpm test:unit`-Falle (s. CLAUDE.md): nur
 * `listenKern.ts` per Relativpfad MIT Endung und ein reiner Typ-Import.
 */
import type { Message } from '../api/types';
import { identitaet } from './listenKern.ts';

/** `geladen` plus die Einträge von `aktuell`, die `geladen` nicht kennt
 *  (ohne `tmp-`-Kopien). Ist nichts zu behalten, kommt `geladen` selbst
 *  zurück. Ändert keine der beiden Listen. */
export function liveBehalten(aktuell: Message[], geladen: Message[]): Message[] {
  if (aktuell.length === 0) return geladen;
  const ids = new Set(geladen.map((m) => m.id));
  const identitaeten = new Set(geladen.map(identitaet));
  const behalten = aktuell.filter(
    (m) => !m.id.startsWith('tmp-') && !ids.has(m.id) && !identitaeten.has(identitaet(m))
  );
  return behalten.length === 0 ? geladen : [...geladen, ...behalten];
}
