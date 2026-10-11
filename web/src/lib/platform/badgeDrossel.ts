/**
 * Wann der Klient seinen Ungelesen-Stand an den Server melden darf.
 *
 * **Warum gedrosselt:** Die Meldung hängt am `$effect` über dem
 * Ungelesen-Stand — in einem lebhaften Gespräch feuert der mehrmals je
 * Sekunde. Ungebremst wären das Dutzende Aufrufe je Minute, und das
 * Drosselband des Gateways (`fcm_badge`, 30/Minute) würde sie abweisen,
 * bevor die wichtige letzte Meldung durchkommt.
 *
 * **Warum die 0 die Drossel überspringt:** „Alles gelesen" ist die eine
 * Meldung, auf die es ankommt — danach soll die Plakette am Icon sofort weg
 * sein. Eine um Sekunden verzögerte 0 ist genau der Fall, den ein Nutzer als
 * Fehler liest („ich habe doch alles gelesen").
 *
 * **Warum es ein `bereit` braucht — und warum gerade die 0 gefährlich ist.**
 * Beim App-Start läuft die Ungelesen-Rechnung, BEVOR der Postfach-Abholweg
 * durch ist: die Zähler sind dann leer und `isUnread` ist `false`, weil
 * `latestByChannel` nur Sitzungsbestand ist. Der Klient rechnet also 0 —
 * und meint damit „ich weiss es noch nicht", meldet es dem Server aber als
 * „alles gelesen". Am Gerät nachgemessen (08.10.): Icon stand korrekt auf 3,
 * App öffnen, Zähler auf dem Server gelöscht, Plakette weg. Solange der
 * Klient seine Zahl nicht verteidigen kann, schweigt er lieber — der
 * Serverzähler ist dann die bessere Auskunft.
 *
 * **Warum importfrei:** damit Nodes Testläufer das Modul überhaupt laden kann
 * (s. `pnpm test:unit`-Falle im CLAUDE.md). Der Aufrufer mit `$lib`-Importen
 * steht daneben in `badgeMelden.ts`.
 */

/** Mindestabstand zweier Meldungen mit einem Wert > 0. */
export const MINDESTABSTAND_MS = 5_000;

export interface Drosselstand {
  /** Zuletzt GEMELDETER Wert; `null` = noch nie gemeldet. */
  letzterWert: number | null;
  /** Zeitpunkt der letzten Meldung (ms, `Date.now()`-Skala). */
  letzteZeit: number;
  /** Ist die Ungelesen-Lage dieser Sitzung geladen? Vorher ist jede Zahl
   *  eine Vermutung — besonders die 0, s. Modulkopf. */
  bereit: boolean;
  /** Hat der Server seit der letzten Meldung womöglich selbst gezählt?
   *  Dann ist auch derselbe Wert eine Nachricht — gedrosselt wie jede
   *  andere (s. `serverHatGezaehlt`). Fehlt das Feld, gilt `false`. */
  gezaehlt?: boolean;
}

/**
 * Wann der Wert gemeldet werden darf: `0` = jetzt, eine Zahl > 0 = in so
 * vielen Millisekunden, `null` = gar nicht (nichts Neues, oder noch nicht
 * geladen).
 *
 * **Warum eine Wartezeit statt eines Ja/Nein** (iOS-Bughunt 2, C3). Bis zum
 * 2026-10-11 verwarf die Drossel eine Zahl innerhalb der Frist einfach. Kam
 * danach keine Änderung mehr — die letzte Nachricht eines Gesprächs —, blieb
 * der Server auf dem Wert davor stehen, und der nächste Push trug ihn auf
 * das Icon. Der Aufrufer meldet jetzt nach Ablauf der Frist nach
 * (`badgeMelden.ts`).
 */
export function wartezeit(stand: Drosselstand, wert: number, jetzt: number): number | null {
  // Noch nichts geladen → nichts behaupten, s. Modulkopf.
  if (!stand.bereit) return null;
  // Derselbe Wert ist keine Nachricht — der Server weiss ihn schon, es sei
  // denn, er hat inzwischen selbst gezählt.
  if (stand.letzterWert === wert && !stand.gezaehlt) return null;
  // Alles gelesen: sofort, s. Modulkopf.
  if (wert === 0) return 0;
  // Erste Meldung dieser Sitzung: sofort, damit ein frisch gestartetes Gerät
  // den Serverstand nicht minutenlang falsch stehen lässt.
  if (stand.letzterWert === null) return 0;
  return Math.max(0, stand.letzteZeit + MINDESTABSTAND_MS - jetzt);
}

/** Darf der Wert JETZT gemeldet werden? Ja/Nein-Form von `wartezeit`. */
export function darfMelden(stand: Drosselstand, wert: number, jetzt: number): boolean {
  return wartezeit(stand, wert, jetzt) === 0;
}

/**
 * Eine Nachricht ist eingegangen, während diese App wach war: der Server
 * hat dafür womöglich selbst hochgezählt (iOS-Bughunt 2, C1).
 *
 * **Warum.** Seit C1 pusht der Server eine DM an jedes iOS-Gerät, auch an
 * eines mit offener Verbindung (`fcm_empfaenger.py`), und zählt dabei hoch.
 * Liest jemand die Nachricht sofort — im offenen Gespräch, oder am Rechner
 * —, ändert sich die Zahl hier nicht, und ohne diesen Merker schwiege der
 * Klient: der Zähler am Server bliebe um eins zu hoch, und der nächste Push
 * legte die falsche Zahl auf das Icon.
 *
 * Anders als `serverStandUnsicher` geht die Meldung nicht sofort, sondern
 * gedrosselt: in einem lebhaften Gespräch kommt dieser Anlass mehrmals je
 * Sekunde.
 */
export function serverHatGezaehlt(stand: Drosselstand): void {
  stand.gezaehlt = true;
}

/**
 * Nach dem Wiederverbinden: der Server kennt den zuletzt gemeldeten Wert
 * NICHT mehr sicher.
 *
 * **Warum.** „Derselbe Wert ist keine Nachricht" (oben) stimmt nur, solange
 * der Server nichts selbst gezählt hat. Er zählt aber hoch, sobald er pusht
 * (`badgezaehler.py::erhoehen`) — also gerade, während diese App im
 * Hintergrund lag. Kam die App zurück und rechnete dieselbe Zahl wie vorher
 * (die neue Nachricht war schon gelesen, oder sie zählt hier gar nicht),
 * schwieg der Klient, und der Zähler am Server blieb oben stehen — die
 * Plakette wuchs beim nächsten Push von einem falschen Sockel aus weiter
 * (Bughunt 2026-10-11, T12).
 *
 * Danach darf (und soll) der nächste Wert gemeldet werden, auch wenn er
 * gleich ist; er geht sofort raus (`letzterWert === null`).
 */
export function serverStandUnsicher(stand: Drosselstand): void {
  stand.letzterWert = null;
}
