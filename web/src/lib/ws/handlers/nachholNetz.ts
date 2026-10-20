/**
 * Verdrahtung der Nachhol-Netze für `chat.ts` — ausgelagert, weil `chat.ts`
 * über der Größen-Grenze liegt. Die Rechnungen stehen importfrei in
 * `../bumpWache.ts` und `../nachholTakt.ts` (Test: `nachhol-netz`), die
 * Verdrahtung prüft `nachhol-verdrahtung`.
 */
import { messages } from '$lib/stores/messages.svelte';
import { gapFillChannel } from '../gapFill';
import { dispatchingServerId } from '../gateway-connection';
import { bumpWacheErzeugen } from '../bumpWache';
import { BUMP_NACHSCHAU_MS, echterPlaner, wiederholerErzeugen } from '../nachholTakt';

const bumpWache = bumpWacheErzeugen({
  liegtVor: (kanalId, nachrichtId) => messages.for(kanalId).some((m) => m.id === nachrichtId),
  // `true` wie beim Kanalwechsel (`GatewayConnection.gapFill`): der Kanal ist
  // offen, eine Seiten-Neuladung als Rückfall gibt es hier nicht.
  nachholen: (kanalId, serverId) => void gapFillChannel(kanalId, true, { serverId }),
  fristMs: BUMP_NACHSCHAU_MS,
  planer: echterPlaner
});

/** Bump für einen OFFENEN (abonnierten) Kanal, fremde Nachricht: liegt sie
 *  nach `BUMP_NACHSCHAU_MS` nicht in der Anzeige, wird der Kanal nachgeholt
 *  (Begründung in `../bumpWache.ts`). Synchron im Handler rufen — der Server
 *  wird hier gelesen (`dispatchingServerId`). */
export function bumpNachschauen(kanalId: string, nachrichtId: string): void {
  const serverId = dispatchingServerId();
  if (serverId) bumpWache.melden(kanalId, nachrichtId, serverId);
}

/** Wiederholer für den Postfach-Zyklus; `abholen` muss den Anzeige-Weg
 *  nehmen (`postfachAbholenAusDerApp`), nie den Zyklus direkt. */
export function postfachWiederholerErzeugen(abholen: () => void) {
  return wiederholerErzeugen(abholen, echterPlaner);
}
