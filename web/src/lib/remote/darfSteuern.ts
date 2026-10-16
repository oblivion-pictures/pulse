/**
 * Darf ich diesen Streamer überhaupt fernsteuern? — die Vorprüfung am
 * Anfrage-Knopf beim Zuschauen (`components/RemoteRequestButton.svelte`) und
 * an dessen Gegenstück im Player-Fenster (`WhepPlayer.svelte`).
 *
 * **Nur noch für Personen** (seit 2026-10-16). Einen Remote-Rechner
 * (Standplatz-Gerät) steuert, wen die Freigabeliste seines Besitzers deckt —
 * `REMOTE_CONTROL` zählt dort nicht mehr; die Regel dafür steht in
 * `$lib/devices/zugang.ts` (`Device.steuerbar`), und `schirme.svelte.ts`
 * fragt sie, nicht diese Datei. Am Strom eines Geräts fällt der Anfrage-Knopf
 * deshalb ganz weg ([`anfragbarAmStrom`]).
 *
 * Best-effort und bewusst nicht der eigentliche Riegel: massgeblich ist der
 * Gateway, der eine Anfrage ohne `REMOTE_CONTROL` mit 4051 abweist. Hier geht
 * es nur darum, einen Weg gar nicht erst anzubieten, den der Server gleich
 * darauf zumacht.
 *
 * Ohne auflösbaren Kanal (DM, Kanal noch nicht im Store) wird **nicht** gegatet:
 * ein fehlender Store-Eintrag ist keine Aussage über Rechte, und der Server
 * entscheidet ohnehin.
 */

import { currentServerUserId } from '$lib/stores/currentServerUser';
import { guilds } from '$lib/stores/guilds.svelte';
import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
import { Perm } from '$lib/permissions/bitfield';
import { stromIstGeraetestrom } from '$lib/devices/darstellung';

export function darfFernsteuern(channelId: string, hostUserId: string): boolean {
  // Sich selbst fernzusteuern ergibt keinen Sinn — und beim eigenen Gerät wäre
  // es der Rechner, an dem man gerade sitzt.
  //
  // **Gegen die serverlokale Kennung** (Bughunt 2026-08-16): `hostUserId` kommt
  // aus einem Stream oder einer Gerätezeile DIESES Servers, `auth.user.id` ist
  // immer die Cloud-Kennung. Auf einem Self-Host traf der Vergleich deshalb nie
  // — der eigene Rechner liess sich anfragen, und der Gateway wies es mit 4050
  // ab, nachdem der Weckruf längst hinaus war.
  if (currentServerUserId() === hostUserId) return false;
  const channel = Object.values(guilds.channelsByGuild)
    .flat()
    .find((c) => c.id === channelId);
  if (!channel) return true;
  return channelPermissions.hasChannelPermission(
    channel.guild_id,
    channel.id,
    Perm.REMOTE_CONTROL,
  );
}

/**
 * Den Anfrage-Knopf an DIESEM Strom zeigen? Wie [`darfFernsteuern`], aber nie
 * am Strom eines Remote-Rechners: dort geht Steuern nur über die Freigabeliste
 * und die Geräteansicht, ein zweiter Weg über den Player fragte etwas an, das
 * der Server ohne Freigabe ablehnt (4062) und mit Freigabe nicht braucht.
 */
export function anfragbarAmStrom(channelId: string, hostUserId: string, slot: number): boolean {
  return !stromIstGeraetestrom(channelId, hostUserId, slot) && darfFernsteuern(channelId, hostUserId);
}
