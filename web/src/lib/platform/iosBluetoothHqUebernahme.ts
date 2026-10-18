/**
 * Die einmalige Übernahme des alten `bluetoothHq` in den einen iOS-Schalter
 * (Rechnung: `iosBluetoothHq.ts`). Nur in der iOS-Hülle; ein Merker im
 * `localStorage` sorgt dafür, dass es bei einem einzigen Start geschieht — der
 * Nutzer darf den Schalter danach ausschalten, ohne dass es zurückkehrt.
 */
import { settings } from '$lib/stores/settings.svelte';
import { funkHqAusAltemSchalter } from './iosBluetoothHq';
import { isCapacitorIOS } from './runtime';

const MERKER = 'pulse.bluetoothHq.uebernommen';

export function bluetoothHqEinmalUebernehmen(): void {
  if (!isCapacitorIOS()) return;
  try {
    if (window.localStorage.getItem(MERKER) === '1') return;
    window.localStorage.setItem(MERKER, '1');
  } catch {
    // Kein Speicher: dann lieber nichts übernehmen, als bei jedem Start
    // einen ausgeschalteten Schalter wieder einzuschalten.
    return;
  }
  const neu = funkHqAusAltemSchalter(settings.audio.bluetoothHq, settings.audio.iosFunkHq);
  if (neu !== null) settings.setIosFunkHq(neu);
}
