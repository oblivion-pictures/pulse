/**
 * Sprachkanal als Systemanruf (CallKit) im nativen Sprachkanal der iOS-App
 * (Einstellung `iosSystemanruf`, Vorgabe aus). Ob der Weg im Moment trägt,
 * entscheidet die Hülle (`SpracheSystemanruf.swift`) — klappt es nicht, läuft
 * der Kanal wie ohne Schalter; hier geht der Wunsch nur hinüber, beim Start
 * und bei jedem Umlegen.
 *
 * Er wirkt sofort, auch mitten im Kanal: CallKit übernimmt die Session für
 * den laufenden Raum oder gibt sie zurück.
 *
 * Ein Bau ohne den Weg bekommt nichts (`nativeSystemanrufDa`); ein
 * gescheiterter Ruf ändert am Kanal nichts, deshalb nur ein Eintrag in der
 * Konsole.
 */
import { huelle } from './iosSprache';
import { nativeSystemanrufDa } from './iosSpracheWeiche';

export function systemanrufSetzen(an: boolean): void {
  if (!nativeSystemanrufDa()) return;
  void huelle()
    ?.systemanruf({ an })
    .catch((e: unknown) => console.warn('[iosSystemanruf] systemanruf gescheitert', e));
}
