/**
 * Welcher Server gerade umbenannt wird. Alle Eingänge — das Rechtsklick-Menü
 * der `GuildRail` am Rechner, die Server-Zeile im Räume-Bereich am Handy und
 * „Umbenennen“ auf „Meine Server“ — rufen nur `ask()`; der Dialog
 * (`ServerRenameDialog`) hängt EINMAL im App-Layout und liest diesen Zustand.
 * So trägt weder die Leiste noch eine Route Dialog-Zustand, und zwei Eingänge
 * können nie zwei Dialoge öffnen.
 */
import type { ServerEntry } from '$lib/api/servers.svelte';

class ServerRenameStore {
  target = $state<ServerEntry | null>(null);
  open = $state(false);

  ask(server: ServerEntry): void {
    this.target = server;
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

export const serverRename = new ServerRenameStore();
