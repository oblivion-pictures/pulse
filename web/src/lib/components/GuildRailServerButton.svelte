<!--
  Server-Knopf unten in der GuildRail: der eine Einstieg für alles rund um
  eigene Server.

    * Überschrift „Meine Server“ mit den EIGENEN Servern des Kontos (Name,
      darunter die Adresse, Status). Ein Klick auf eine Zeile wechselt zu diesem
      Server; steht er nicht in der Server-Liste dieses Geräts, führt er zur
      Seite „Meine Server“. Ein „Verwalten“ je Zeile gibt es nicht — das gilt
      für alle Server gemeinsam und steht unten.
    * „Eigenen Server einrichten …“ öffnet `EigenerServerDialog`.
    * „Server verwalten“ öffnet `/app/server`, nur mit eigenem Server.

  Die Zeilen kommen bei jedem Öffnen frisch aus der Cloud (wie die Seite
  `account/MyInstances`), der Name aber aus der Leiste, sobald der Server dort
  steht (`instanzZeile`). Formsprache wie `GuildRailPlusMenu`: bits-ui-
  DropdownMenu, `side="right"`.

  Sichtbar nur in der Desktop-Klasse — die `GuildRail` ist es auch. Handy und
  Tablet erreichen dieselbe Seite über den Du-Bereich (`MeSectionList`) und
  richten Server über das Menü der Räume ein (`RaeumeMenue`).

  Der Tooltip hängt an einem Wrapper-Div, nicht am Knopf: ein zweiter
  Trigger-Spread auf dem Knopf überschriebe die Klick-Handler des Menüs, dann
  öffnete es nur per Tastatur (s. Kommentar im Plus-Menü).
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import ServerIcon from '@lucide/svelte/icons/server';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import ServerCogIcon from '@lucide/svelte/icons/server-cog';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import { serversStore } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { hatEigeneServer } from '$lib/selfhost/eigeneServer';
  import { instanzZeile } from '$lib/servers/anzeige';
  import { m } from '$lib/paraglide/messages.js';

  let menueOffen = $state(false);
  let tipOffen = $state(false);
  let eigene = $state<Instance[]>([]);
  let geladen = $state(false);
  let ladefehler = $state(false);

  // „Server verwalten“ nur mit eigenem Server. Zwei Quellen, weil jede allein
  // eine Lücke lässt: die Server-Liste des Geräts ist sofort da, kennt aber
  // keinen Server, den die Cloud noch nicht als eingerichtet führt; die frisch
  // geladene Liste dagegen zeigt Zeilen, bevor die Server-Liste nachgezogen hat.
  let hatServer = $derived(hatEigeneServer(serversStore.servers) || eigene.length > 0);

  /** Bei jedem Öffnen frisch aus der Cloud, nur EIGENE Server. */
  async function laden(): Promise<void> {
    try {
      eigene = (await instancesApi.listMyInstances()).filter((i) => i.role === 'owner');
      ladefehler = false;
    } catch {
      // Die Liste bleibt, wie sie war. Ohne sie darf das Menü nicht behaupten,
      // es gäbe keinen Server (`ladefehler` hält den Leer-Hinweis zurück).
      ladefehler = true;
    } finally {
      geladen = true;
    }
  }

  $effect(() => {
    if (menueOffen) void laden();
  });

  function oeffnen(inst: Instance): void {
    const eintrag = serversStore.servers.find((s) => s.instance_id === inst.id);
    if (eintrag) activeServer.set(eintrag.id);
    else void goto('/app/server');
  }

  function statusClass(s: string): string {
    return s === 'active' ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive';
  }
</script>

<Tooltip.Root open={tipOffen && !menueOffen} onOpenChange={(v) => (tipOffen = v)}>
  <Tooltip.Trigger>
    {#snippet child({ props: tipProps })}
      <div {...tipProps} class="relative shrink-0">
        <DropdownMenu.Root bind:open={menueOffen}>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="text-text-muted hover:bg-bg-hover hover:text-primary data-[state=open]:bg-bg-hover data-[state=open]:text-primary flex size-12 items-center justify-center rounded-xl transition-all hover:rounded-md nicht-handy:size-10"
                data-testid="rail-server-button"
                aria-label={m.server_knopf_label()}
              >
                <ServerIcon class="size-6 nicht-handy:size-5" />
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            side="right"
            align="end"
            class="w-80"
            data-testid="rail-server-menu"
          >
            <DropdownMenu.Label>{m.eigener_server_meine_server()}</DropdownMenu.Label>
            {#if !geladen}
              <p class="text-text-muted px-2 py-1.5 text-sm">{m.my_instances_loading()}</p>
            {:else if eigene.length === 0}
              {#if !ladefehler}
                <p class="text-text-muted px-2 py-1.5 text-sm" data-testid="rail-server-empty">
                  {m.eigener_server_liste_leer()}
                </p>
              {/if}
            {:else}
              {#each eigene as inst (inst.id)}
                {@const zeile = instanzZeile(
                  inst,
                  serversStore.servers.find((s) => s.instance_id === inst.id)
                )}
                <DropdownMenu.Item
                  onclick={() => oeffnen(inst)}
                  class="items-start gap-2"
                  data-testid="rail-server-row-{inst.id}"
                >
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span
                      class="text-text-bright truncate text-sm font-medium"
                      data-testid="rail-server-name-{inst.id}"
                    >
                      {zeile.name}
                    </span>
                    {#if zeile.adresse}
                      <span
                        class="text-text-muted truncate text-xs"
                        data-testid="rail-server-adresse-{inst.id}"
                      >
                        {zeile.adresse}
                      </span>
                    {/if}
                  </span>
                  <span
                    class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium {statusClass(
                      inst.status
                    )}"
                  >
                    {inst.status === 'active'
                      ? m.eigener_server_status_aktiv()
                      : m.my_instances_status_suspended()}
                  </span>
                </DropdownMenu.Item>
              {/each}
            {/if}
            <DropdownMenu.Separator />
            <!-- `onclick` wie die Dialog-Einträge im Konto-Menü (UserFooter:
                 Einstellungen, Problem melden). Dass der Dialog danach bedienbar
                 ist, belegen eigener-server.spec.ts und server-knopf.spec.ts mit
                 einem Klick auf „Schließen“ im Dialog. -->
            <DropdownMenu.Item
              onclick={() => (uiOverlays.eigenerServerOpen = true)}
              data-testid="rail-server-einrichten"
            >
              <PlusIcon />
              {m.server_knopf_einrichten()}
            </DropdownMenu.Item>
            {#if hatServer}
              <DropdownMenu.Item
                onclick={() => void goto('/app/server')}
                data-testid="rail-server-verwalten"
              >
                <ServerCogIcon />
                {m.server_knopf_verwalten()}
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Content side="right">{m.server_knopf_label()}</Tooltip.Content>
</Tooltip.Root>
