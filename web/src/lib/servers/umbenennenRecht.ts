/**
 * Darf der angemeldete Mensch DIESEN Server umbenennen? — die Rechnung steht in
 * `umbenennen.ts` (importfrei, geprüft); hier werden nur die Eingaben aus den
 * Stores geholt. Eine Stelle für beide Eingänge: das Rechtsklick-Menü der
 * `GuildRail` am Rechner und die Server-Zeile im Räume-Bereich am Handy.
 */
import type { ServerEntry } from '$lib/api/servers.svelte';
import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
import { darfServerUmbenennen } from './umbenennen';

export function darfUmbenennen(server: ServerEntry): boolean {
  return darfServerUmbenennen({
    istCloud: server.isCloud,
    rolleLautCloud: server.role ?? null,
    adminLautServer: serverAdmin.has(server.id) ? serverAdmin.isAdmin(server.id) : null
  });
}
