<!--
  Das „+“ unter jeder Server-Gruppe der GuildRail: Community erstellen (nur mit
  Erstellrecht), Community beitreten, und — nach einem Trenner, in jedem Plus
  gleich — „Eigenen Server einrichten“ (Spec 2026-10-09 §5; ersetzt den
  Server-Knopf unten in der Leiste). Herausgezogen aus `GuildRail.svelte`,
  damit die Leiste schrumpft statt wächst.

  Bewusst kleiner als die Community-Symbole (gestrichelt), damit es als
  Sektions-Aktion liest. Die Beschriftung des Knopfes zählt auf, was das Menü
  anbietet — auch den Server-Eintrag, der in jedem Plus steht. Der Aufrufer aktiviert vor `onAnlegen`/`onBeitreten`
  den Server — die neue Community landet garantiert auf DIESEM Server.
-->
<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import UsersRoundIcon from '@lucide/svelte/icons/users-round';
  import LogInIcon from '@lucide/svelte/icons/log-in';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    serverId,
    darfAnlegen,
    onAnlegen,
    onBeitreten
  }: {
    serverId: string;
    /** Admin oder `allow_guild_creation` (lib/servers/erstellrecht.ts). */
    darfAnlegen: boolean;
    onAnlegen: () => void;
    onBeitreten?: () => void;
  } = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <!-- KEIN Tooltip-Wrapper: ein zweiter Trigger-Spread (tipProps)
           überschreibt die Klick-Handler des DropdownMenu-Triggers, dann
           öffnet das Menü nur per Tastatur, nicht per Maus. aria-label
           deckt die Zugänglichkeit ab. -->
      <button
        {...props}
        class="border-primary/40 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl border border-dashed nicht-handy:size-10 bg-transparent transition-all hover:bg-primary/10"
        data-testid={`guild-create-menu-${serverId}`}
        aria-label={darfAnlegen
          ? m.guild_rail_plus_aria_anlegen()
          : m.guild_rail_plus_aria_beitreten()}
      >
        <PlusIcon class="size-4" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="right" align="start" class="w-56">
    {#if darfAnlegen}
      <DropdownMenu.Item onSelect={onAnlegen} data-testid="guild-create">
        <UsersRoundIcon />
        {m.guild_rail_create_community()}
      </DropdownMenu.Item>
    {/if}
    {#if onBeitreten}
      <DropdownMenu.Item onSelect={onBeitreten} data-testid="guild-join">
        <LogInIcon />
        {m.guild_rail_join_community()}
      </DropdownMenu.Item>
    {/if}
    <DropdownMenu.Separator />
    <!-- `onclick` wie die Dialog-Einträge im Konto-Menü (UserFooter: Einstellungen,
         Problem melden). Dass der Dialog danach bedienbar ist, belegt
         eigener-server.spec.ts mit einem Klick auf „Schließen“ im Dialog. -->
    <DropdownMenu.Item
      onclick={() => (uiOverlays.eigenerServerOpen = true)}
      data-testid="guild-eigener-server"
    >
      <ServerIcon />
      {m.eigener_server_einrichten()}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
