<!--
  Menü oben rechts im Räume-Bereich (Handy und Tablet). Herausgezogen aus
  `routes/app/rooms/+page.svelte`, als „Eigenen Server einrichten“ dazukam —
  das Gegenstück zum Plus der GuildRail, die es hier nicht gibt (Spec
  2026-10-09 §5).

  Drei-Punkte wie in Chats und Freunde: Entdecken ist der Ausgang ins
  Verzeichnis, kein dauerhaft sichtbarer Zustand der eigenen Räume. „Community
  beitreten“ = Server per Adresse beitreten (Erstkontakt, kein Invite-Code):
  `/app?add=join` wie die GuildRail; warum es diesen Einstieg auf Handy und
  Tablet braucht, steht in `CommunityBeitretenKnopf.svelte`.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import CompassIcon from '@lucide/svelte/icons/compass';
  import LogInIcon from '@lucide/svelte/icons/log-in';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import ServerIcon from '@lucide/svelte/icons/server';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        class="text-text-muted hover:bg-bg-hover hover:text-text-bright flex size-12 items-center justify-center rounded-[14px] transition-colors"
        data-testid="rooms-menu"
        aria-label={m.chats_menu()}
      >
        <EllipsisIcon class="size-6" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-56">
    <DropdownMenu.Item
      onclick={() => void goto('/app?add=join')}
      data-testid="rooms-menu-join"
      class="flex items-center gap-2"
    >
      <LogInIcon class="size-4" />
      {m.guild_rail_join_community()}
    </DropdownMenu.Item>
    <DropdownMenu.Item
      onclick={() => void goto('/app/discover')}
      data-testid="rooms-menu-discover"
      class="flex items-center gap-2"
    >
      <CompassIcon class="size-4" />
      {m.rooms_discover_short()}
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item
      onclick={() => (uiOverlays.eigenerServerOpen = true)}
      data-testid="rooms-eigener-server"
      class="flex items-center gap-2"
    >
      <ServerIcon class="size-4" />
      {m.eigener_server_einrichten()}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
