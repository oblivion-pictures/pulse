<script lang="ts">
  /**
   * Bestätigung „Community verlassen" samt Austritt. Geteilt zwischen der
   * `GuildRail` (Rechner) und dem Räume-Bereich (Handy), damit beide denselben
   * Text, dieselbe Fehlerbehandlung und dieselben `data-testid` haben.
   */
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { guilds as guildsStore } from '$lib/stores/guilds.svelte';
  import type { Guild } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    guild,
    onVerlassen
  }: {
    open?: boolean;
    guild: Guild | null;
    /** Nach dem Austritt, mit der ID — der Aufrufer navigiert ggf. weg. */
    onVerlassen?: (guildId: string) => void;
  } = $props();

  let busy = $state(false);

  async function bestaetigen(): Promise<void> {
    if (!guild) return;
    const id = guild.id;
    busy = true;
    try {
      await chatApi.leaveGuild(id);
      // Lokal entfernen + (falls aktiv) wegnavigieren — gleiche UX wie beim
      // Delete; das ``guild_member_removed``-WS-Event räumt parallel mit auf.
      guildsStore.remove(id);
      onVerlassen?.(id);
      open = false;
    } catch (err) {
      toast.error(m.guild_rail_leave_failed(), { description: (err as Error).message });
    } finally {
      busy = false;
    }
  }
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content data-testid="leave-guild-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.guild_rail_leave_community_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.guild_rail_leave_community_description({ name: guild?.name ?? m.guild_rail_this_community() })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={busy}>{m.guild_rail_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={bestaetigen}
        disabled={busy}
        data-testid="leave-guild-confirm"
      >
        {busy ? m.guild_rail_leaving() : m.guild_rail_leave_action()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
