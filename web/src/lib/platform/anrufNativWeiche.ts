/**
 * Die Weiche zum nativen Anrufweg auf iOS (Etappe 4): trägt der installierte
 * App-Bau den Anruf-Raum? Ist er es nicht, gibt es in der iOS-Hülle keinen Anruf
 * über WebKit mehr (Eigentümer-Entscheid E6, 2026-10-18), sondern die
 * Aufforderung, die App zu aktualisieren (`anrufwegVeraltet`).
 *
 * **Mit `.ts`-Endungen in den Importen**, damit Nodes Läufer die Datei ganz
 * lädt — samt echtem `@capacitor/core` (`test/anruf-nativ-weiche.test.ts`).
 * Dieselbe Begründung wie bei `iosSpracheWeiche.ts`: die Antwort ist die
 * teuerste Zeile des Wegs, und eine Prüfung, die nur ihre Annahmen nachstellt,
 * hat das schon einmal übersehen (Bughunt 2026-10-11, K1).
 */

import { ANRUF_RAUM_METHODEN } from './anrufNativ.ts';
import { huellenBefund } from './huelleKann.ts';
import { nativerSprachwegBefund } from './iosSpracheWeiche.ts';
import { isCapacitorIOS } from './runtime.ts';

/**
 * Nativer Anrufweg — ja oder nein.
 *
 * **Nur zusammen mit dem nativen Sprachweg.** Die beiden teilen sich eine
 * Audio-Session, und deren Übergabe (`AnrufSitzung.swift`) rechnet mit einem
 * KANAL, der nativ läuft und sich anhalten lässt. Ein Bau ohne nativen
 * Sprachweg hat diese Gegenstelle nicht (und einen Kanal über WebKit neben
 * einem nativen Anruf gäbe es als zweite Partei an der Session — genau die
 * Lage, aus der der Umbau herausführt).
 *
 * **Und nur mit ALLEN Methoden** (`ANRUF_RAUM_METHODEN`): eine Hülle mit dem
 * alten `Anruf`-Plugin (ankommen, beenden, voipToken) gilt als „veraltet"
 * (`anrufwegVeraltet`) — ein halber nativer Anruf sähe verbunden aus und wäre
 * stumm.
 */
export function nativerAnrufwegDa(): boolean {
  if (!nativerSprachwegBefund().nativ) return false;
  return huellenBefund('Anruf', ANRUF_RAUM_METHODEN).da;
}

/**
 * Ist das eine iOS-Hülle, die den nativen Anrufweg NICHT (vollständig) trägt?
 * Dann darf ein Anruf nicht auf die WebView ausweichen — weder ausgehend noch
 * eingehend —, sondern die Oberfläche verlangt die Aktualisierung über
 * TestFlight. Browser (auch iPhone-Safari ohne Hülle), Desktop und Android
 * sind nie „veraltet" und behalten ihren Web-Anruf.
 */
export function anrufwegVeraltet(): boolean {
  return isCapacitorIOS() && !nativerAnrufwegDa();
}
