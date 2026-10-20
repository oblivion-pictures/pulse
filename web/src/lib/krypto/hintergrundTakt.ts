/**
 * Hintergrund-Takt der Hülle: solange die App hinten ist, holt eine Runde in
 * einem sanften Intervall das Postfach ab — über DENSELBEN Anzeige-Weg wie der
 * `postfach_neu`-Weckruf (`ws/handlers/chat.ts::postfachImHintergrundAbholen`),
 * nur ohne Ton, Toast und In-Page-Meldung. Jede Runde legt die Nachrichten ab,
 * verbucht sie als ungelesen (Zähler, Chat-Liste, Gruppen-Reihenfolge) und
 * quittiert sie, womit beim Absender der doppelte Haken erscheint.
 *
 * Bis zum 2026-10-20 rief der Takt nur `postfachAbholenUndEntschluesseln` und
 * warf das Ergebnis weg: die Nachrichten lagen abgelegt und quittiert im
 * Verlauf, aber nichts zählte sie — nach der Rückkehr in die App fehlten sie
 * in „ungelesen", weil das Postfach sie ja schon geleert hatte.
 *
 * **Was der Takt NICHT kann: den Prozess wachhalten.** Nichts in Pulse hält
 * die WebView im Hintergrund am Leben (kein Vordergrund-Dienst ausserhalb eines
 * Anrufs). Der Takt läuft nur, solange das System die WebView nicht einfriert
 * oder beendet — wie lange das ist, entscheidet das Betriebssystem (Android:
 * Doze, App-Standby, Einfrieren zwischengespeicherter Prozesse; iOS friert
 * die App nach dem Wechsel ohnehin ein). Gemessen ist keine Dauer. Die
 * verlässliche Meldung bei geschlossener App ist allein der Push vom Server;
 * der Takt ist eine Zugabe für die Zeit, in der der Prozess noch läuft.
 *
 * **Warum 60 s.** Chromium drosselt Hintergrund-Timer auf mindestens eine
 * Minute — ein engeres Intervall würde still entwertet. Sofort beim Start
 * läuft eine Extra-Runde, die das Szenario „gerade fertig gechattet, Handy
 * weg" abdeckt.
 *
 * Gestartet/gestoppt wird der Takt von `app/+layout.svelte` über die
 * netzwache-Haken (`beiHintergrund`/`beiVordergrund`, beide Hüllen); ein
 * doppelter Start ist wirkungslos.
 *
 * Importfrei, damit Nodes Testläufer ihn prüft (s. die `pnpm test:unit`-Falle
 * in CLAUDE.md) — die Runde selbst reicht der Aufrufer herein.
 */
export const HINTERGRUND_TAKT_MS = 60_000;

let takt: ReturnType<typeof setInterval> | null = null;

/** Den Hintergrund-Takt anhalten (Vordergrund übernommen). */
export function hintergrundZyklusStoppen(): void {
  if (takt !== null) {
    clearInterval(takt);
    takt = null;
  }
}

/** Den Takt starten: `runde` sofort einmal, dann alle `HINTERGRUND_TAKT_MS`. */
export function hintergrundZyklusStarten(runde: () => void): void {
  if (takt !== null) return;
  runde();
  takt = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      // Vordergrund hat übernommen (die netzwache-Haken stoppen den Takt dort
      // auch selbst) — hier nur sauber aufräumen.
      hintergrundZyklusStoppen();
      return;
    }
    runde();
  }, HINTERGRUND_TAKT_MS);
}
