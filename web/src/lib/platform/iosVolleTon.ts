/**
 * **„Volle Tonqualität" wird vorerst nicht angeboten** (Eigentümer-Entscheid
 * 2026-10-17): auf dem iPhone gilt Apples eigene Sprachverarbeitung (VPIO).
 *
 * Der Schalter tauschte VPIO gegen WebRTCs Software-Verarbeitung (Befund B,
 * „dumpf wie am Telefon"); deren Echo-Unterdrückung am iPhone-Lautsprecher ist
 * schwächer als Apples und am Gerät nie abgenommen worden. Bis das geschieht,
 * kommt der Schalter nicht in die Oberfläche, und ein früher gespeichertes
 * „an" greift beim Beitritt nicht mehr.
 *
 * **Abgeschaltet, nicht entfernt:** der native Weg (`.software`-Optionen,
 * Wiederherstellung nach der Anruf-Pause, Diagnosefelder `vpio`/`aec`/`kbps`)
 * bleibt im Bau und ist nur unerreichbar — zurück geht es mit dieser Zeile.
 * Die Einstellung samt Setter bleibt ebenfalls, damit ein späteres
 * Wiederanbieten den gespeicherten Wunsch nicht verliert.
 *
 * Importfrei (CLAUDE.md, `pnpm test:unit`).
 */
export const VOLLE_TONQUALITAET_ANGEBOTEN = false;

/** Was der Beitritt an die Hülle schickt — der gespeicherte Wunsch zählt nur,
 *  solange der Schalter angeboten wird. */
export function volleTonqualitaetWirksam(gespeichert: boolean): boolean {
  return VOLLE_TONQUALITAET_ANGEBOTEN && gespeichert;
}
