/**
 * Die Mitteilungs-Einstellungen von Pulse im Android-System öffnen — das
 * native Plugin `Systemeinstellungen` der Android-Hülle.
 *
 * Gegenstück zum iOS-Weg in `HuelleMitteilungen.svelte` (`app-settings:`):
 * hat der Nutzer die Mitteilungen verweigert, kann die App nicht erneut
 * fragen; einschalten lassen sie sich nur noch in den Systemeinstellungen.
 *
 * **Ältere Hüllen kennen das Plugin nicht.** `mitteilungenOeffnenMoeglich`
 * fragt deshalb VOR dem Anzeigen des Knopfs den installierten Bau
 * (`huelleKann.ts`); fehlt die Methode, bleibt der Knopf weg, statt ins Leere
 * zu tippen.
 */
import { registerPlugin } from '@capacitor/core';

import { huelleKennt } from './huelleKann';
import { isCapacitorAndroid } from './runtime';

interface SystemeinstellungenPlugin {
  mitteilungenOeffnen(): Promise<void>;
}

const plugin = registerPlugin<SystemeinstellungenPlugin>('Systemeinstellungen');

/** Trägt die installierte Android-Hülle den Weg in die Einstellungen? */
export function mitteilungenOeffnenMoeglich(): boolean {
  return isCapacitorAndroid() && huelleKennt('Systemeinstellungen', 'mitteilungenOeffnen');
}

/** Die Mitteilungs-Einstellungen öffnen; still, wenn es nicht geht. */
export async function mitteilungsEinstellungenOeffnen(): Promise<void> {
  try {
    await plugin.mitteilungenOeffnen();
  } catch {
    /* Ältere Hülle — der Knopf hätte gar nicht erscheinen dürfen. */
  }
}
