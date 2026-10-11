import { vergleicheSnowflakeArtigeId } from '../utils/snowflakeZeit.ts';
import { nachrichtIdentitaet } from './identitaet.ts';

/**
 * Fuehrt den lokalen Bestand eines DM-Kanals mit der Serverantwort zusammen
 * — importiert bewusst NUR `../utils/snowflakeZeit.ts` und `./identitaet.ts`
 * (beide selbst importfrei, per erweiterungspflichtigem Relativpfad
 * eingebunden), damit Nodes Testlaeufer die einzige echte Rechnung dieser
 * Etappe direkt prueft (s. CLAUDE.md „Die Falle").
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
 *  Anhänge, …) reist als beliebige Nutzlast im generischen Typ `T` mit.
 *
 *  `kryptoId` und `autorId` (optional): zusammen die Identität der
 *  Nachricht (`identitaet.ts`). Dieselbe logische Nachricht trägt auf jedem
 *  Gerät eine ANDERE lokale ID (der Autor seine eigene, jeder Empfänger die
 *  Zustellungs-ID seines Umschlags) — die Sicherung eines anderen Geräts
 *  liefert sie deshalb als scheinbar neue Zeile. Gleiche Identität heißt
 *  gleiche Nachricht; ohne `autorId` zählt der Autor als leer. */
export type Mergeposten = {
  id: string;
  kryptoId?: string | null;
  autorId?: string | null;
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
 * `lokal` ist die erste Quelle, `vomServer` ergänzt/überschreibt sie —
 * AUSSER ein lokaler Posten ist ein Grabstein: dann bleibt er einer, egal
 * was (oder ob überhaupt etwas) der Server zu derselben ID sagt.
 *
 * GLEICHE Identität zählt wie gleiche `id` (2026-09-11, Autor-Bindung
 * 2026-10-11): die Kopie vom anderen Gerät wird verworfen statt doppelt
 * angezeigt. Der bereits liegende Posten gewinnt (bei gleicher `id`
 * überschreibt der Server wie bisher — dort geht es um Bearbeitungen; bei
 * verschiedener `id` ist der Inhalt ohnehin identisch). Ein Grabstein auf
 * EINE Kopie deckt die logische Nachricht insgesamt ab — gelöscht heißt
 * gelöscht, egal welches Gerät den Stein gesetzt hat und in welcher
 * Reihenfolge die Kopien hier ankommen. Bis 2026-10-11 galt das nur, wenn
 * der Stein ZUERST kam; kam die sichtbare Kopie vorher, blieb sie stehen.
 * Der Stein ist hier ein lokaler Satz mit eigenem Autor, kein Sicherungs-
 * Rahmen — die Bindung an seine Identität ist die des Satzes selbst.
 */
export function zusammenfuegen<T extends Mergeposten>(lokal: T[], vomServer: T[]): T[] {
  // Platz → Posten; ein Platz ist die `id` des ersten Postens einer Nachricht.
  const plaetze = new Map<string, T>();
  const platzJeId = new Map<string, string>();
  const platzJeIdentitaet = new Map<string, string>();
  for (const posten of [...lokal, ...vomServer]) {
    const identitaet = nachrichtIdentitaet(posten.autorId, posten.id, posten.kryptoId);
    const platz = platzJeId.get(posten.id) ?? platzJeIdentitaet.get(identitaet) ?? posten.id;
    if (verdraengt(plaetze.get(platz), posten)) plaetze.set(platz, posten);
    if (!platzJeId.has(posten.id)) platzJeId.set(posten.id, platz);
    if (!platzJeIdentitaet.has(identitaet)) platzJeIdentitaet.set(identitaet, platz);
  }
  return [...plaetze.values()].sort((a, b) => vergleicheId(a.id, b.id));
}

/** Ob `neu` den Posten verdrängt, der schon auf seinem Platz liegt. */
function verdraengt(liegend: Mergeposten | undefined, neu: Mergeposten): boolean {
  if (liegend === undefined) return true;
  if (liegend.geloescht) return false; // Grabstein überlebt
  // Gleiche id: der spätere (Server) gewinnt. Verschiedene id bei gleicher
  // Identität ist das Duplikat vom anderen Gerät, der liegende Posten
  // bleibt — außer der neue ist der Grabstein.
  return liegend.id === neu.id || neu.geloescht;
}
