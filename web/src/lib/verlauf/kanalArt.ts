/**
 * Welche Kanäle lokal geführt werden und welche einen Server-Verlauf haben —
 * aus `index.ts` herausgelöst (2026-10-12), als die Lösch-Wege nach
 * `loeschen.ts` zogen und dieselbe Frage brauchten. Inhalt unverändert.
 */
import { directMessages } from '$lib/stores/directMessages.svelte';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { ABLAGE_KANAL_ENABLED } from '$lib/featureFlags';
import { brauchtLokalenVerlauf } from './ablageEntscheidung';

/**
 * Ob `kanalId` ein Ablage-Kanal ist (Guild-Kanal mit `ablage: true`) —
 * genau wie eine private Gruppe von Geburt an verschluesselt, nur ueber die
 * Guild-Kanalliste statt `privateGruppen` erreichbar, s. `kanalSenden.ts`-
 * Modulkopf.
 *
 * **Hinter dem Merkmal-Schalter.** Aus heisst: wie ein gewoehnlicher
 * Guild-Kanal behandeln, unabhaengig vom `ablage`-Feld — der Schalter ist
 * ein Schalter, kein Versteck (CLAUDE.md), aber solange er aus ist, darf
 * sich an diesem Weg nichts aendern.
 */
function istAblageKanal(kanalId: string): boolean {
  const guildId = guilds.guildIdForChannel(kanalId);
  if (!guildId) return false;
  const channel = guilds.channelsByGuild[guildId]?.find((c) => c.id === kanalId);
  return brauchtLokalenVerlauf(ABLAGE_KANAL_ENABLED, channel);
}

/**
 * Nur DM-Kanäle, private Gruppen und Ablage-Kanäle werden lokal abgelegt —
 * gewöhnliche Community-Kanäle bleiben serverseitig (Spec §9). Die
 * Unterscheidung läuft über die Kanal-ID, nicht über die Aufrufstelle:
 * `chat.ts`/`gapFill.ts`/`MessageList.svelte` bedienen DM- UND Guild-Kanäle
 * gleichermassen, ein Filter nach Aufrufstelle träfe das falsch.
 *
 * **Private Gruppen UND Ablage-Kanäle sind für die lokale Ablage nicht nur
 * die bevorzugte, sondern die EINZIGE Kopie** — beide sind von Geburt an
 * verschlüsselt (Spec §9), der Server hat also nie einen Klartext gesehen,
 * auf den man zurückfallen könnte. Bei einer DM gibt es diesen Rückfall
 * solange, wie der Klartext-Weg mitläuft.
 */
export function istLokalerKanal(kanalId: string): boolean {
  return (
    kanalId in directMessages.byId ||
    privateGruppen.istGruppe(kanalId) ||
    istAblageKanal(kanalId)
  );
}

/**
 * Ob es zu diesem Kanal ueberhaupt einen Verlauf auf dem Server gibt.
 *
 * Nicht die Umkehrung von `istLokalerKanal`: eine DM ist beides — sie liegt
 * lokal UND (solange der Klartext-Weg mitlaeuft) auf dem Server. Eine
 * private Gruppe oder ein Ablage-Kanal hat dort nichts, weil der Server
 * ihren Klartext nie gesehen hat. Wer das nicht prueft, schickt beim
 * Hochscrollen in einer Gruppe/einem Ablage-Kanal eine Anfrage, die der
 * Server abweist — und deutet die Abweisung dann als Ladefehler statt als
 * „mehr gibt es nicht".
 */
export function hatServerVerlauf(kanalId: string): boolean {
  return !privateGruppen.istGruppe(kanalId) && !istAblageKanal(kanalId);
}
