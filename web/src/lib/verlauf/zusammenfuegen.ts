import { vergleicheSnowflakeArtigeId } from '../utils/snowflakeZeit.ts';
import { kanonischeNachrichtId } from './nachrichtIdentitaet.ts';

/**
 * Fuehrt den lokalen Bestand eines DM-Kanals mit der Serverantwort zusammen
 * — importiert bewusst NUR `../utils/snowflakeZeit.ts` und
 * `./nachrichtIdentitaet.ts` (beide selbst importfrei und per
 * erweiterungspflichtigem Relativpfad eingebunden), damit Nodes Testlaeufer
 * die einzige echte Rechnung dieser Etappe direkt prueft (s. CLAUDE.md „Die
 * Falle").
 *
 * Vier Faelle (Plan Task 2, Schritt 1): Duplikate erscheinen einmal, der
 * Server gewinnt bei bearbeiteten Nachrichten, ein lokaler Grabstein
 * ueberlebt eine Server-Antwort ohne ihn, und die Reihenfolge folgt den
 * Nachrichten-IDs.
 *
 * "Ohne ihn" ist dabei der REGELFALL, kein Rand: der Server liefert
 * geloeschte Nachrichten grundsaetzlich nicht mehr aus (`Message.deleted_at
 * .is_(None)`-Filter in `routes/messages.py`) — "fehlt in der Server-Antwort"
 * beweist also nichts ueber die Nachricht, nur, dass der Server sie (aus
 * welchem Grund auch immer) gerade nicht ausliefert.
 */

/** Was die Merge-Rechnung von einem Posten braucht — der Rest (Inhalt,
 *  Anhaenge, …) reist als beliebige Nutzlast im generischen Typ `T` mit.
 *
 *  `kryptoId` (optional, 2026-09-11): die vom AUTOR gewaehlte, geraete-
 *  uebergreifende Nachrichten-ID (`krypto/nachrichtNutzlast.ts`). Dieselbe
 *  logische Nachricht traegt auf jedem Geraet eine ANDERE lokale ID (der
 *  Autor seine eigene, jeder Empfaenger die Zustellungs-ID seines
 *  Umschlags) — die Sicherung eines anderen Geraets liefert sie deshalb
 *  als scheinbar neue Zeile. Verglichen wird die kanonische ID
 *  (`nachrichtIdentitaet.ts`: `kryptoId`, ohne sie die eigene `id`) —
 *  so erkennt der Merge auch die Kopie des Autors aus einem Altbestand,
 *  die keine `kryptoId` traegt. */
export type Mergeposten = {
  id: string;
  kryptoId?: string | null;
  bearbeitetAm: string | null;
  geloescht: boolean;
};

/**
 * ID-Vergleich fuer den Merge — die eigentliche Rechnung (eingebettete Zeit
 * aus beiden ID-Schemata entschluesseln und DIE vergleichen, statt roh nach
 * Laenge/lexikografisch) steht in `../utils/snowflakeZeit.ts` (dort
 * ausfuehrlich begruendet, inkl. warum "auf gemeinsame Breite auffuellen,
 * dann lexikografisch" ebenfalls NICHT reicht). Frueher hier dupliziert,
 * weil dieses Modul ueber `$lib/utils/snowflake` importfrei bleiben musste —
 * ein erweiterungspflichtiger Relativpfad (`../utils/snowflakeZeit.ts`)
 * loest das, ohne die Node-Testlaeufer-Falle (s. CLAUDE.md) zu beruehren.
 */
const vergleicheId = vergleicheSnowflakeArtigeId;

/**
 * `lokal` ist die erste Quelle, `vomServer` ergaenzt/ueberschreibt sie —
 * AUSSER ein lokaler Posten ist ein Grabstein: dann bleibt er einer, egal
 * was (oder ob ueberhaupt etwas) der Server zu derselben ID sagt.
 *
 * GLEICHE kanonische ID zaehlt wie gleiche `id` (2026-09-11, Altbestand ohne
 * `kryptoId` seit 2026-10-13): die Kopie vom anderen Geraet wird verworfen
 * statt doppelt angezeigt. Der bereits liegende Posten gewinnt (bei gleicher
 * `id` ueberschreibt der Server wie bisher — dort geht es um Bearbeitungen;
 * bei verschiedener `id` ist der Inhalt ohnehin identisch). Ein Grabstein
 * auf EINE Kopie deckt die logische Nachricht insgesamt ab — geloescht heisst
 * geloescht, egal welches Geraet den Stein gesetzt hat und in welcher
 * Reihenfolge die Kopien hier ankommen: kommt der Stein NACH einer
 * sichtbaren Kopie, verdraengt er sie.
 */
export function zusammenfuegen<T extends Mergeposten>(lokal: T[], vomServer: T[]): T[] {
  const byId = new Map<string, T>();
  const idJeKanon = new Map<string, string>();
  for (const posten of [...lokal, ...vomServer]) {
    const kanon = kanonischeNachrichtId(posten.id, posten.kryptoId);
    const eigen = byId.get(posten.id);
    const stellvertreter = idJeKanon.get(kanon);
    const bestehend = eigen ?? (stellvertreter === undefined ? undefined : byId.get(stellvertreter));
    if (bestehend !== undefined) {
      if (bestehend.geloescht) continue; // Grabstein ueberlebt
      // Gleiche id: der spaetere Kandidat (Server) gewinnt — Bearbeitung.
      // Verschiedene id bei gleicher kanonischer ID: Duplikat vom anderen
      // Geraet, der bereits liegende Posten bleibt — es sei denn, das
      // Duplikat ist ein Grabstein.
      if (bestehend.id !== posten.id) {
        if (!posten.geloescht) continue;
        byId.delete(bestehend.id);
      }
    }
    idJeKanon.set(kanon, posten.id);
    byId.set(posten.id, posten);
  }
  return [...byId.values()].sort((a, b) => vergleicheId(a.id, b.id));
}
