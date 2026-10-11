/**
 * **Der Schutz eines überlebenden nativen Raums gilt ab dem Laden der Seite,
 * nicht erst ab seiner Übernahme** (iOS-Bughunt 2 vom 2026-10-11, B4).
 *
 * Drei Dinge gelten genau so lange, wie die Hülle einen Raum hält: WebKits
 * Session ist `ambient`, `iosTon` fasst die Session nicht an, und die WebView
 * öffnet kein Mikrofon (`iosSprache.ts`, `halter`). Nach einem Neuladen hält
 * die Hülle den Raum weiter — die neue Seite gab die Erklärung aber erst bei
 * der Übernahme ab, und die wartet seit Runde 1 auf die Entsperrung, die
 * Anmeldung und den WS-Start (`voice/startBeitritte.ts`). Bis dahin zog ein
 * Oberflächen-Ton (Mitteilungston, Tippen) WebKits nicht mischbare Session
 * an sich und unterbrach den Kanal — dieselbe Falle wie der Beitritts-Ton vom
 * 2026-10-10 (Messung an `webSessionTyp`) —, und eine Sprachnachricht hätte
 * ihm das Mikrofon genommen. **Am Code gefolgert, nicht am Gerät gemessen.**
 *
 * Darum fragt die Seite gleich beim Laden, ob ein Raum steht — nur lesend, ohne
 * Aussenwirkung, also auch vor Face ID erlaubt —, und hält den Schutz unter
 * einem eigenen Namen, bis der Abgleich entschieden hat
 * (`NativerRaum.uebernehmen`). Übernimmt er, hält ab da der Kanal; verlässt er
 * den Raum, fällt der Schutz weg.
 */

import { huelleHaeltRaum } from '$lib/voice/nativAbgleich';
import { nativerSprachwegDa, nativerTonHalten, spracheZustand } from './iosSprache';

/** Hat der Abgleich schon entschieden? Dann kommt eine späte Antwort der
 *  Hülle zu spät und darf den Schutz nicht wieder setzen. */
let entschieden = false;

/** Beim Laden der App-Seite, vor allem anderen. Ausserhalb des nativen Wegs
 *  ein No-op. */
export async function spracheRaumVorhalten(): Promise<void> {
  if (!nativerSprachwegDa()) return;
  const z = await spracheZustand().catch(() => null);
  if (entschieden || !huelleHaeltRaum(z)) return;
  nativerTonHalten('vorhalt', true);
}

/** Der Abgleich hat entschieden (jedes Ergebnis). */
export function spracheVorhaltLoesen(): void {
  entschieden = true;
  nativerTonHalten('vorhalt', false);
}
