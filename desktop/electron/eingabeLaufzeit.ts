/**
 * Fernsteuerung, HOST-Seite: wie lange Eingaben vom Steuernden bis hierher
 * brauchen — als eine Zeile je Minute in der `sidecar.log`.
 *
 * **Warum es das gibt** (2026-10-22). Der Eigentuemer hatte den Eindruck, eine
 * Fernsteuerung werde im Lauf der Sitzung „zaeher". Bild und Ton liessen sich
 * nachmessen (Uebergabe beim Sender, Laufzeit zum Server, Netz-bis-Schirm beim
 * Zuschauer — nichts davon wuchs ueber 30 Minuten), der Eingabeweg nicht: Maus
 * und Tastatur laufen ueber den Server zum Host, und keine Seite schrieb mit,
 * wie lange. Staut sich dort etwas an, faellt es genau als „zaeh" auf.
 *
 * **Was gemessen wird.** Der Steuernde stempelt jede Eingabe-Nachricht mit
 * seiner Uhrzeit (`t`, `web/src/lib/remote/session.svelte.ts::sendInput`), der
 * Gateway reicht sie durch (`routes/ws_remote_input.py`), hier wird `jetzt − t`
 * genommen. Darin steckt der Uhrenversatz der beiden Rechner — am 2026-10-22
 * ging der gesteuerte Rechner 33 s nach. Deshalb steht in der Zeile die
 * Laufzeit UEBER DEM KLEINSTEN Wert der Sitzung: der Versatz faellt heraus,
 * ein Anstau zeigt sich als wachsender Wert.
 *
 * **Grenze, ehrlich:** laufen die Uhren beider Rechner verschieden schnell,
 * waechst der Wert auch ohne Stau gleichmaessig mit (50 ppm waeren 3 ms je
 * Minute). Ein echter Stau zeigt sich anders — als wachsende Streuung (p95,
 * max) und in Spruengen, nicht als gleichmaessige Rampe.
 *
 * Reine Rechnung mit der Uhr von aussen, ohne `electron`-Import — damit der
 * Test sie stellen kann (Muster wie `player-leerlauf.ts`).
 */

/** Eine Zeile je so viel Zeit, solange Eingaben kommen. */
export const MELDE_TAKT_MS = 60_000;

/** Hoechstens so viele Proben je Zeile (der Player schickt bis zu 125
 *  Nachrichten je Sekunde, `player.ts`). Darueber wird nicht mehr gesammelt —
 *  fuer Median und 95. Perzentil reicht das reichlich. */
const MAX_PROBEN = 8_000;

export class EingabeLaufzeit {
  #sitzung: string | null = null;
  /** Kleinste Rohlaufzeit der Sitzung: Uhrenversatz plus schnellste Zustellung. */
  #minRoh = Number.POSITIVE_INFINITY;
  #proben: number[] = [];
  #fensterBeginn: number | null = null;

  /** Eine Eingabe-Nachricht kam an. Ohne brauchbares `t` (aeltere Fassung des
   *  Steuernden) zaehlt sie nicht. */
  erfassen(sessionId: string, t: unknown, jetzt = Date.now()): void {
    if (typeof t !== 'number' || !Number.isFinite(t)) return;
    if (sessionId !== this.#sitzung) {
      this.#sitzung = sessionId;
      this.#minRoh = Number.POSITIVE_INFINITY;
      this.#proben = [];
      this.#fensterBeginn = jetzt;
    }
    const roh = jetzt - t;
    if (roh < this.#minRoh) this.#minRoh = roh;
    if (this.#proben.length < MAX_PROBEN) this.#proben.push(roh);
  }

  /** Die Zeile, wenn eine faellig ist (ein Takt um, oder `zumSchluss` beim
   *  Sitzungsende) — danach beginnt ein neues Fenster. Sonst `null`. */
  faellig(jetzt = Date.now(), zumSchluss = false): string | null {
    if (this.#fensterBeginn === null || this.#proben.length === 0) return null;
    const dauer = jetzt - this.#fensterBeginn;
    if (!zumSchluss && dauer < MELDE_TAKT_MS) return null;
    const ueber = this.#proben.map((roh) => roh - this.#minRoh).sort((a, b) => a - b);
    const rang = (q: number): number =>
      ueber[Math.min(ueber.length - 1, Math.max(0, Math.ceil(q * ueber.length) - 1))];
    const zeile =
      `[eingabe] Laufzeit vom Steuernden hierher (${Math.round(dauer / 1000)} s, ` +
      `n=${ueber.length}): ueber dem Sitzungsminimum p50 ${Math.round(rang(0.5))} / ` +
      `p95 ${Math.round(rang(0.95))} / max ${Math.round(ueber[ueber.length - 1])} ms; ` +
      `Sitzungsminimum roh ${Math.round(this.#minRoh)} ms (enthaelt den Uhrenversatz)`;
    this.#proben = [];
    this.#fensterBeginn = jetzt;
    return zeile;
  }
}
