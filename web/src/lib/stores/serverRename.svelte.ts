/**
 * Welcher Server gerade umbenannt wird. Die beiden Eingänge — das Rechtsklick-
 * Menü der `GuildRail` am Rechner und die Server-Zeile im Räume-Bereich am
 * Handy — rufen nur `ask()`; der Dialog (`ServerRenameDialog`) hängt EINMAL im
 * App-Layout und liest diesen Zustand. So trägt weder die Leiste noch die Route
 * Dialog-Zustand, und zwei Eingänge können nie zwei Dialoge öffnen.
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
