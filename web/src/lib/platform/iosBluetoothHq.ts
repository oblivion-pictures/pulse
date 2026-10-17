/**
 * Der EINE Bluetooth-HQ-Schalter der iOS-Hülle (Review W2).
 *
 * Es gab zwei: `bluetoothHq` (Web-Rückfall älterer Bauten) und `iosFunkHq`
 * (nativer Sprachkanal) — je nach Bau stand nur einer in den Einstellungen,
 * und wer den Bau wechselte, hatte den anderen irgendwo „gesetzt". Jetzt
 * steuert der eine Schalter beide (`IosTonEinstellungen.svelte`). Einmalig
 * wird ein früher gespeichertes „an" des alten Web-Schalters übernommen: wer
 * Bluetooth-HQ ausdrücklich eingeschaltet hatte, soll es nicht durch einen
 * später ausgeschalteten `iosFunkHq` verlieren.
 *
 * Importfrei (CLAUDE.md, `pnpm test:unit`): hier nur die Rechnung.
 */

/** Neuer Wert für `iosFunkHq` aus dem alten `bluetoothHq`, oder `null`: nichts
 *  zu übernehmen. Nur ein gespeichertes „an" sagt etwas — „aus" ist zugleich
 *  die Vorgabe und damit kein Wunsch. */
export function funkHqAusAltemSchalter(bluetoothHq: boolean, iosFunkHq: boolean): boolean | null {
  return bluetoothHq && !iosFunkHq ? true : null;
}
