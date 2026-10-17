/**
 * Der EINE Bluetooth-HQ-Schalter der iOS-Hülle (Review W2).
 *
 * Es gab zwei: `bluetoothHq` (Web-Sprachweg der iOS-Hülle) und `iosFunkHq`
 * (nativer Sprachkanal). Den Web-Sprachweg gibt es nicht mehr (Eigentümer-
 * Entscheid E6, 2026-10-18); in den Einstellungen steht nur noch `iosFunkHq`.
 * Einmalig wird ein früher gespeichertes „an" des alten Schalters übernommen:
 * wer Bluetooth-HQ ausdrücklich eingeschaltet hatte, soll es nicht durch einen
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
