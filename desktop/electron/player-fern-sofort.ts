/**
 * Der Haken „Bild sofort zeigen" des Players über Sitzungen und Player-Prozesse
 * hinweg merken.
 *
 * Der Player führt den Wert für seinen Prozess selbst
 * (`streaming/pulse-player/src/app/sofortbild.rs`, Bedeutung in
 * `app/takt/fernsteuerung.rs`). Er geht aber nach der Leerlauf-Frist und mit
 * der App zu Ende, und ohne Gedächtnis stünde der Haken danach wieder auf der
 * Vorgabe. Deshalb meldet der Player jeden Wechsel (`player:fernSofort`), der
 * Hauptprozess legt ihn im Store ab und gibt ihn dem nächsten Player-Prozess
 * als `PULSE_PLAYER_FERN_SOFORT` mit.
 *
 * **Nur der Hauptprozess liest und schreibt den Schlüssel** — wie
 * `recordingDir`. Der Renderer braucht ihn nicht, er steht deshalb bewusst
 * nicht in `ALLOWED_STORE_KEYS`.
 *
 * Bewusst ohne `electron`-Import — damit als reine Funktion prüfbar.
 */

/** Store-Schlüssel des Hakens; Wert `true`/`false`, fehlt = Vorgabe des Players. */
export const FERN_SOFORT_SCHLUESSEL = 'playerFernSofort';

/**
 * Der Wert für `PULSE_PLAYER_FERN_SOFORT` aus dem gespeicherten Stand.
 * `undefined` = nichts gespeichert (oder Unlesbares) → der Player nimmt seine
 * Vorgabe. Eine von außen gesetzte Variable gewinnt; das prüft der Aufrufer.
 */
export function fernSofortUmgebung(gespeichert: unknown): '0' | '1' | undefined {
  if (gespeichert === true) return '1';
  if (gespeichert === false) return '0';
  return undefined;
}

/** Der neue Stand aus einer Player-Meldung, sonst `undefined`. */
export function fernSofortAusMeldung(msg: Record<string, unknown>): boolean | undefined {
  if (msg.ev !== 'player:fernSofort' || typeof msg.an !== 'boolean') return undefined;
  return msg.an;
}
