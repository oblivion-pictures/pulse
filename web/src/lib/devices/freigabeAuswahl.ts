/**
 * Lädt, was die Freigabeliste eines Remote-Rechners zum Auswählen braucht:
 * Mitglieder und Rollen der Community und — seit 2026-10-16 — wer davon den
 * Standplatz-Kanal sieht (`kanalSicht.ts`).
 *
 * Zwei getrennte Schritte mit getrenntem Fehlerweg: scheitert die Sicht
 * (Rollen, Overwrites), bleibt die Auswahl ungefiltert und ohne Hinweise —
 * der Server prüft ohnehin. Scheitert schon die Mitgliederliste, bleibt sie
 * leer wie bisher.
 *
 * Dieselben vier Routen wie `krypto/gruppe/kanalMitglieder.ts`; die Rollen
 * kommen hier aus der Route statt aus dem Rollen-Store, weil „Meine
 * Remote-Rechner" auch Geräte in Communitys zeigt, deren Rollen nie geladen
 * wurden.
 */

import { chatApi } from '$lib/api/chat';
import { overwritesApi, rolesApi } from '$lib/api/roles';
import { toBitfield } from '$lib/permissions/bitfield';
import { userCache } from '$lib/stores/users.svelte';
import { kanalSicht, type KanalSicht } from './kanalSicht';

export interface FreigabeAuswahl {
  mitglieder: string[];
  rollen: { id: string; name: string }[];
  sicht: KanalSicht | null;
}

export async function freigabeAuswahlLaden(
  guildId: string,
  channelId: string,
): Promise<FreigabeAuswahl> {
  let mitglieder: string[] = [];
  try {
    mitglieder = (await chatApi.listMembers(guildId)).map((mm) => mm.user_id);
    for (const id of mitglieder) userCache.queue(id);
  } catch {
    return { mitglieder: [], rollen: [], sicht: null };
  }
  try {
    const [guild, rollen, rollenIds, overwrites] = await Promise.all([
      chatApi.getGuild(guildId),
      rolesApi.list(guildId),
      rolesApi.bulkMemberRoles(guildId),
      overwritesApi.list(channelId),
    ]);
    return {
      mitglieder,
      rollen: rollen.filter((r) => !r.is_everyone).map((r) => ({ id: r.id, name: r.name })),
      sicht: kanalSicht({
        mitglieder: mitglieder.map((id) => ({ userId: id, rollenIds: rollenIds[id] ?? [] })),
        rollen: rollen.map((r) => ({
          id: r.id,
          position: r.position,
          permissions: toBitfield(r.permissions),
          is_everyone: r.is_everyone,
        })),
        overwrites: overwrites.map((o) => ({
          target_type: o.target_type,
          target_id: o.target_id,
          allow: toBitfield(o.allow),
          deny: toBitfield(o.deny),
        })),
        besitzerId: guild.owner_id,
      }),
    };
  } catch {
    return { mitglieder, rollen: [], sicht: null };
  }
}
