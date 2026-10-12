<!--
  Kopfzeile eines Servers im Räume-Bereich (Handy/Tablet): Name über den
  Kacheln seiner Communities.

  Mit `onUmbenennen` ist die Zeile ein Knopf — für den Betreiber/Admin des
  Servers. Am Handy gibt es keinen Rechtsklick; hier ist die Stelle, an der der
  Server angetippt wird (ein langes Drücken, das Android als Kontextmenü
  meldet, tut dasselbe). Das Stift-Zeichen sagt, dass da etwas geht — ohne es
  wüsste niemand, dass die Zeile mehr ist als eine Überschrift. Die Fläche ist
  48 dp hoch (`mobile-treffflaechen.spec.ts` misst das).

  Ohne `onUmbenennen` bleibt es die schlichte Überschrift wie bisher.
-->
<script lang="ts">
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import { serverDisplayName, type ServerEntry } from '$lib/api/servers.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    server,
    onUmbenennen
  }: {
    server: ServerEntry;
    onUmbenennen?: () => void;
  } = $props();

  // Schema-Rauschen gehört nicht in die UI (wie in der GuildRail).
  const name = $derived(serverDisplayName(server).replace(/^https?:\/\//, ''));
</script>

{#if onUmbenennen}
  <button
    type="button"
    class="text-text-muted active:text-text-bright flex min-h-12 w-full items-center gap-2 px-1 pt-1 text-left text-xs font-bold"
    onclick={onUmbenennen}
    oncontextmenu={(e) => {
      e.preventDefault();
      onUmbenennen();
    }}
    aria-label={m.server_rename_row_aria({ name })}
    data-testid={`rooms-server-rename-${server.id}`}
  >
    <span class="min-w-0 truncate">{name}</span>
    <PencilIcon class="size-3.5 shrink-0" aria-hidden="true" />
  </button>
{:else}
  <div class="text-text-muted px-1 pb-1.5 pt-3 text-xs font-bold">{name}</div>
{/if}
