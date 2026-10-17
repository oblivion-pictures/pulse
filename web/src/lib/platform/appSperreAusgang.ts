/**
 * Was die Antwort des Sperre-Plugins für die App-Sperre heisst — als reine
 * Rechnung, damit der Node-Läufer sie prüfen kann (`appSperre.svelte.ts` hat
 * Runen auf Modulebene und ist dort nicht ladbar).
 *
 * **Warum es einen vierten Ausgang gibt:** wer den Geräte-Code nach dem
 * Einschalten der Sperre wieder entfernt, kann sich nie wieder entsperren —
 * `deviceOwnerAuthentication` scheitert dann jedes Mal. `kein_code` heisst:
 * die Sperre BLEIBT (nie aufschliessen, weil nicht geprüft werden kann), die
 * Sperrfläche erklärt es und bietet das Abmelden an — der Wiedereinstieg ist
 * dann eine normale Anmeldung.
 */

export interface SperreAntwort {
  ok: boolean;
  abgebrochen?: boolean;
  grund?: string;
}

export type SperreAusgang = 'entsperrt' | 'abgebrochen' | 'kein_code' | 'fehler';

/** Das Kennwort, mit dem der Swift-Teil „kein Geräte-Code gesetzt" meldet. */
export const GRUND_KEIN_CODE = 'kein_code';

/**
 * `verfuegbar` ist der Rückfall für ältere Bauten, die den Grund `kein_code`
 * noch nicht kennen und nur `ok:false` mit dem Systemtext melden: ein
 * gescheiterter Versuch, der kein Abbruch war, und ein Gerät, das gar nicht
 * mehr prüfen kann, ist derselbe Fall. Schlägt die Rückfrage selbst fehl,
 * bleibt es beim Fehler — nie aus Unsicherheit aufschliessen.
 */
export async function sperreAusgang(
  antwort: SperreAntwort,
  verfuegbar: () => Promise<boolean>,
): Promise<SperreAusgang> {
  if (antwort.ok) return 'entsperrt';
  if (antwort.abgebrochen) return 'abgebrochen';
  if (antwort.grund === GRUND_KEIN_CODE) return 'kein_code';
  try {
    if (!(await verfuegbar())) return 'kein_code';
  } catch {
    /* Rückfrage gescheitert: Fehler bleibt Fehler */
  }
  return 'fehler';
}
