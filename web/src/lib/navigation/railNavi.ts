/**
 * Rail-nahe Navigations-Helfer: was ein Klick auf eine Guild bzw. einen DM-
 * Eintrag in der GuildRail / DMChannelList tut (Route). Dieselben zwei
 * Funktionen standen vorher in vier Bereichs-Seiten (@me, friends, invites,
 * server) doppelt. Den Kanal-Drawer (`navDrawer`), den sie früher mit
 * öffneten/schlossen, gibt es seit dem Mobil-Umbau nicht mehr.
 *
 * Der Kanal-Kanal (`guilds/.../[channelId]`) bleibt bewusst eigens: dort ist
 * der Parameter die Guild-ID selbst und ein Klick auf die aktive Guild soll
 * nichts navigieren.
 */
import { goto } from '$app/navigation';

/** Guild in der Rail angeklickt: in die Kanal-Liste der Guild. */
export async function selectGuild(g: { id: string }): Promise<void> {
  await goto(`/app/guilds/${g.id}/channels/_`);
}

/** DM in der Liste angeklickt: in den Chat. */
export async function selectDM(dm: { id: string }): Promise<void> {
  await goto(`/app/@me/${dm.id}`);
}
