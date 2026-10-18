<script lang="ts">
  /**
   * Das Blatt hinter dem ⋯-Knopf einer Community-Kachel im Räume-Bereich
   * (Handy/Tablet) samt den Dialogen, die seine Aktionen öffnen. Einmal pro
   * Seite, nicht pro Kachel: die Kachel setzt nur `ziel`.
   *
   * Die Aktionen und ihre Rechte kommen aus `guild/guildAktionen.ts` — dieselbe
   * Quelle wie das Kontextmenü der `GuildRail` am Rechner. Das Blatt gibt es nur
   * für Communitys des AKTIVEN Servers (Rollen und Besitzer liegen nur dort im
   * Speicher); die Seite zeigt den Knopf entsprechend nur dort.
   */
  import { untrack } from 'svelte';
  import AktionsBlatt from './AktionsBlatt.svelte';
  import MitgliederBlatt from './MitgliederBlatt.svelte';
  import GuildVerlassenDialog from '$lib/components/guild/GuildVerlassenDialog.svelte';
  import RenameGuildDialog from '$lib/components/RenameGuildDialog.svelte';
  import GuildSettingsDialog from '$lib/components/settings/GuildSettingsDialog.svelte';
  import { guildAktionen, guildRechte, istAdminAufServer } from '$lib/components/guild/guildAktionen';
  import { serversStore } from '$lib/api/servers.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import type { Guild } from '$lib/api/types';

  let {
    ziel = null
  }: {
    /** Die angetippte Kachel; jedes Antippen übergibt ein NEUES Objekt. */
    ziel?: { guild: Guild; serverId: string } | null;
  } = $props();

  let blattOffen = $state(false);
  let umbenennen = $state<Guild | null>(null);
  let einstellungenOffen = $state(false);
  let einstellungenZiel = $state<Guild | null>(null);
  let verlassenOffen = $state(false);
  let verlassenZiel = $state<Guild | null>(null);
  let mitgliederOffen = $state(false);
  let mitgliederZiel = $state<string | null>(null);

  $effect(() => {
    if (ziel) untrack(() => (blattOffen = true));
  });

  const server = $derived(ziel ? serversStore.find(ziel.serverId) : undefined);
  const aktionen = $derived.by(() => {
    if (!ziel || !server) return [];
    const g = ziel.guild;
    const rechte = guildRechte(g, {
      aktiverServer: true,
      userId: currentServerUserId(),
      serverAdmin: istAdminAufServer(server)
    });
    return guildAktionen(g, rechte, {
      einstellungen: () => {
        einstellungenZiel = g;
        einstellungenOffen = true;
      },
      umbenennen: () => (umbenennen = g),
      verlassen: () => {
        verlassenZiel = g;
        verlassenOffen = true;
      },
      mitglieder: () => {
        mitgliederZiel = g.id;
        mitgliederOffen = true;
      }
    });
  });
</script>

<AktionsBlatt
  bind:open={blattOffen}
  {aktionen}
  titel={ziel?.guild.name}
  testid="community-aktionen"
/>
{#if mitgliederZiel}
  <MitgliederBlatt bind:open={mitgliederOffen} guildId={mitgliederZiel} />
{/if}
<RenameGuildDialog
  open={umbenennen !== null}
  guild={umbenennen}
  onClose={() => (umbenennen = null)}
/>
<GuildSettingsDialog bind:open={einstellungenOffen} guild={einstellungenZiel} />
<GuildVerlassenDialog bind:open={verlassenOffen} guild={verlassenZiel} />
