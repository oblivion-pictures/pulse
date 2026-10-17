/**
 * Der Griff auf das native Plugin `ShareReceiver` — an EINER Stelle
 * registriert: ein zweites `registerPlugin` unter demselben Namen liefert
 * nur eine Warnung. Genutzt vom Abruf (`shareEmpfang.ts`) und vom Laden der
 * Dateien (`freigabe/freigabeDateien.ts`).
 *
 * Android kennt nur `getPending` (Text, ein Bild als Base64); `leseDatei` und
 * `abschliessen` gibt es auf iOS, und nur, wenn `getPending` mit
 * `mitDateien: true` Dateien geliefert hat.
 */
import { registerPlugin } from '@capacitor/core';

export interface ShareReceiverPlugin {
  getPending(opt?: { mitDateien?: boolean }): Promise<{
    text?: string;
    imageBase64?: string;
    imageMime?: string;
    paketId?: string;
    dateien?: { id: string; name: string; mime: string; groesse: number }[];
    uebersprungen?: number;
  }>;
  /** Ein Stück einer Datei des Pakets; `ende`, wenn danach nichts mehr kommt. */
  leseDatei(opt: {
    paketId: string;
    id: string;
    offset: number;
    laenge: number;
  }): Promise<{ base64: string; ende: boolean }>;
  /** Die Seite ist fertig: die Hülle löscht die Dateien des Pakets. */
  abschliessen(opt: { paketId: string }): Promise<void>;
}

export const ShareReceiver = registerPlugin<ShareReceiverPlugin>('ShareReceiver');
