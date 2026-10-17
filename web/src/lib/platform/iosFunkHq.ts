/**
 * Bluetooth-Kopfhörer in hoher Qualität im nativen Sprachkanal der iOS-App
 * (Einstellung `iosFunkHq`, Vorgabe an). Die Hülle merkt sich den Wunsch und
 * entscheidet selbst, ob Route und iOS ihn tragen (`SpracheFunkHq.swift`);
 * hier geht er nur hinüber — beim Start und bei jedem Umlegen.
 *
 * Ein Bau ohne den Weg bekommt nichts (`nativeFunkHqDa`); ein gescheiterter
 * Ruf ändert am Kanal nichts, deshalb nur ein Eintrag in der Konsole.
 */
import { huelle } from './iosSprache';
import { nativeFunkHqDa } from './iosSpracheWeiche';

export function funkHqSetzen(an: boolean): void {
  if (!nativeFunkHqDa()) return;
  void huelle()
    ?.funkHq({ an })
    .catch((e: unknown) => console.warn('[iosFunkHq] funkHq gescheitert', e));
}
