/**
 * „Diesen Bildschirm schließen" — die Seite des GERÄTS.
 *
 * Der Steuernde schickt `schirm_zu` mit einem Platz (`$lib/remote/schirmZu.ts`);
 * hier endet die Übertragung genau dieses Platzes, die übrigen und die Sitzung
 * laufen weiter. Die Bildschirmliste beim Steuernden zieht von selbst nach: das
 * Gerät meldet seine laufenden Plätze ohnehin aus [`geraeteSlots`]
 * (`DeviceKiosk.svelte`).
 *
 * **Nur Plätze, die ein Weckruf gestartet hat** (`platzAbgeben`): was der
 * Besitzer von Hand überträgt, gehört ihm — dieselbe Grenze wie beim
 * Einschlafen. Der Direktplatz (P2P) ebenfalls nicht: er ist die ganze Sitzung.
 *
 * **Den Ton reicht niemand weiter** (zurückgestellt, 2026-10-16): trug der
 * geschlossene Bildschirm den Systemton, ist er danach weg.
 */
import { MAX_STREAM_SLOTS } from '$lib/stream/state.svelte';
import { stopSlot } from '$lib/stream/slotControl.svelte';
import { slotAusSignal } from '$lib/remote/schirmZuRegel';
import { schirmAbschiede } from './abschiede';
import { platzAbgeben } from './wecken';

export function schirmZuEmpfangen(daten: unknown): void {
  const slot = slotAusSignal(daten, MAX_STREAM_SLOTS);
  if (slot === null || !platzAbgeben(slot)) return;
  // VOR dem Stopp: der Sidecar weist ab dem `stop` Eingaben ab, und
  // `ws/handlers/remote.ts` beendete daran sonst die ganze Sitzung.
  schirmAbschiede.markieren(slot, Date.now());
  // Der Grund reist im `stop` mit und steht damit in der `sidecar.log` — wie
  // beim Einschlafen (`wecken.ts::wiederEinschlafen`).
  void stopSlot(slot, 'Bildschirm vom Steuernden geschlossen');
}
