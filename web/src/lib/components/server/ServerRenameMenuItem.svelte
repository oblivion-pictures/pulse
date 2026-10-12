<!--
  „Umbenennen“ im Rechtsklick-Menü eines Servers in der Leiste (`GuildRail`).

  Sichtbar nur für Admin/Besitzer DIESES Servers (`darfUmbenennen`), nicht für
  das Cloud-Plattform-Flag. Der Dialog selbst hängt einmal im App-Layout
  (`ServerRenameDialog`); das Menü schließt sich beim Auswählen, ein Dialog
  innerhalb des Menüs würde mit ihm verschwinden — deshalb der gemeinsame
  Zustand in `stores/serverRename`.
-->
<script lang="ts">
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import type { ServerEntry } from '$lib/api/servers.svelte';
  import { darfUmbenennen } from '$lib/servers/umbenennenRecht';
  import { serverRename } from '$lib/stores/serverRename.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { server }: { server: ServerEntry } = $props();
</script>

{#if darfUmbenennen(server)}
  <ContextMenu.Item onSelect={() => serverRename.ask(server)} data-testid="server-rename-menu">
    <PencilIcon /> {m.server_rename_menu()}
  </ContextMenu.Item>
{/if}
