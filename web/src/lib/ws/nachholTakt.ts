/**
 * Fristen und Wiederholstufen des Nachholens — die reine Rechnung hinter
 * „im offenen Chat kommt manchmal eine Nachricht nicht an" (Push-Bughunt,
 * 2026-10-21). Importfrei und damit von Nodes Testläufer prüfbar (s. die
 * `pnpm test:unit`-Falle in CLAUDE.md); Test: `nachhol-netz`.
 *
 * Die Zahlen sind geschätzt, nicht gemessen.
 */

/** Wartezeiten nach dem 1., 2., 3. Fehlschlag; nach dem vierten wird
 *  aufgehört, bis ein neuer Auslöser kommt. Klein genug, dass ein kurzer
 *  Aussetzer (Netzwechsel, Server-Neustart) ohne Zutun heilt, und nach
 *  gut 20 s vorbei — danach übernehmen die gewöhnlichen Auslöser
 *  (Neuaufbau, `ready`, nächster Weckruf). */
export const NACHHOL_STUFEN_MS: readonly number[] = [2_000, 5_000, 15_000];

/** Wartezeit vor dem nächsten Versuch nach `fehlschlaege` Fehlschlägen in
 *  Folge, oder `null` = aufhören. */
export function naechsteWartezeit(
  fehlschlaege: number,
  stufen: readonly number[] = NACHHOL_STUFEN_MS
): number | null {
  if (fehlschlaege < 1) return null;
  return stufen[fehlschlaege - 1] ?? null;
}

/**
 * Wie lange ein Bump auf sein `message`-Ereignis warten darf. Der Server
 * veröffentlicht `message` VOR dem Bump (`ws_op_send.py`, `messages.py`,
 * `system_dm.py`), und ein Gateway-Prozess stellt beide über denselben
 * Listener der Reihe nach zu — im Normalfall liegt die Nachricht also schon
 * in der Anzeige, wenn der Bump kommt. Garantiert ist das nicht (zwei
 * Redis-Kanäle, `chat:channel:<id>` und `guild:events`; Betrieb mit mehreren
 * Gateway-Prozessen ist nicht nachgeprüft), deshalb eine Marge statt einer
 * sofortigen Prüfung: kurz genug, dass eine verlorene Nachricht noch im
 * Blick des Lesers erscheint, lang genug für eine ausgelastete
 * Ereignisschleife am Telefon.
 */
export const BUMP_NACHSCHAU_MS = 2_000;

/** Abo-Fehlerrahmen, nach denen ein neuer Versuch etwas ändern kann: 5000
 *  (Ausnahme im Server, etwa die Datenbank kurz weg) und 4004 (Kanal nicht
 *  erreichbar). 4004 ist oft dauerhaft (kein Mitglied); dann kosten die drei
 *  Versuche drei kleine Rahmen und hören auf — ob es auch vorübergehend
 *  vorkommt, ist nicht belegt. Nicht 4003 (kaputte Kanal-ID) und nicht 4012
 *  (kein Leserecht): dort bliebe jeder Versuch gleich. Codes:
 *  `routes/ws_ops_handlers.py::handle_subscribe`, 5000 aus `routes/ws_ops.py`. */
export const ABO_WIEDERHOLBARE_FEHLER: ReadonlySet<number> = new Set([4004, 5000]);

/** Zeitgeber, von aussen gereicht — im Betrieb `setTimeout`, im Test eine
 *  künstliche Uhr. */
export type Planer = {
  planen(fn: () => void, ms: number): unknown;
  abbrechen(griff: unknown): void;
};

export const echterPlaner: Planer = {
  planen: (fn, ms) => setTimeout(fn, ms),
  abbrechen: (griff) => clearTimeout(griff as ReturnType<typeof setTimeout>)
};

/**
 * Wiederholt `ausfuehren` nach Fehlschlägen auf den Stufen oben.
 *
 * - Mehrere Fehlschlagmeldungen, während eine Runde geplant ist, zählen als
 *   eine — derselbe Fehlschlag erreicht oft mehrere Aufrufer.
 * - Nach der letzten Stufe: aufhören und den Zähler auf null, damit ein
 *   späterer Auslöser, der wieder scheitert, die Leiter von vorn beginnt.
 * - `erfolgreich` setzt zurück und bricht eine geplante Runde ab.
 */
export function wiederholerErzeugen(
  ausfuehren: () => void,
  planer: Planer,
  stufen: readonly number[] = NACHHOL_STUFEN_MS
): { fehlgeschlagen(): void; erfolgreich(): void } {
  let fehlschlaege = 0;
  let griff: unknown = null;
  return {
    fehlgeschlagen() {
      if (griff !== null) return;
      fehlschlaege += 1;
      const warte = naechsteWartezeit(fehlschlaege, stufen);
      if (warte === null) {
        fehlschlaege = 0;
        return;
      }
      griff = planer.planen(() => {
        griff = null;
        ausfuehren();
      }, warte);
    },
    erfolgreich() {
      fehlschlaege = 0;
      if (griff !== null) planer.abbrechen(griff);
      griff = null;
    }
  };
}
