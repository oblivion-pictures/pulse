<!--
  SettingsStandplatzGeraete — „Meine Remote-Rechner".

  Der Grund, warum der Reiter auch dort sichtbar ist, wo dieser RECHNER selbst
  kein Standplatz sein kann (Linux, macOS, Browser — `reiterSichtbar.ts`):
  jemand kann Geräte BESITZEN, ohne gerade an einem von ihnen zu sitzen. Diese
  Liste zeigt jedes Gerät, dessen Besitzer der angemeldete Nutzer auf DIESEM
  Server ist, und wird deshalb unabhängig von `kannStandplatz` gerendert.

  **Nur Liste, Verwaltung klappt inline auf** (seit 2026-09-09): eine Zeile
  führt NICHT mehr in die Geräteansicht — der Klick klappt unter der Zeile
  die `DeviceVerwaltung` auf (Akkordeon, eine Zeile gleichzeitig), das Panel
  ist damit der einzige Ort, den man für diese Geräte braucht. Der eigene
  Rechner ist markiert statt doppelt aufgeführt.

  **Je Gerät auch seine Freigabeliste** (seit 2026-10-16): seit die Liste
  allein entscheidet, wer einen Rechner wecken und steuern darf, muss der
  Besitzer sie für JEDEN seiner Rechner pflegen können — nicht nur für den,
  an dem er gerade sitzt (`SettingsStandplatzRechner`). Beim eigenen Rechner
  steht sie damit zweimal im Panel; beide lesen denselben Speicher.

  **Läuft über alle geladenen Communitys** (`deviceStore.eigene`), lädt sie
  aber selbst nach: ohne den Effect unten wüsste der Store nur von der
  Community, in der man gerade eine Kanalliste geöffnet hatte.
-->
<script lang="ts">
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { punktKlasse, zeileFuer } from '$lib/devices/darstellung';
  import { geraetOrtText } from '$lib/devices/ort';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import DeviceVerwaltung from '$lib/devices/components/DeviceVerwaltung.svelte';
  import DeviceFreigaben from '$lib/devices/components/DeviceFreigaben.svelte';
  import { m } from '$lib/paraglide/messages.js';

  $effect(() => {
    for (const g of guilds.list) {
      void deviceStore.ensureLoaded(g.id);
      void guilds.ensureChannels(g.id);
    }
  });

  const eigeneGeraete = $derived(deviceStore.eigene(currentServerUserId()));
  const diesesGeraetId = $derived(geraeteAnmeldung.fuerServer(activeServer.serverId)?.deviceId ?? null);

  /** Akkordeon: die aufgeklappte Zeile zeigt die Verwaltung inline — Klick
   *  verlässt das Panel nicht mehr (Remote-UI-Runde 2026-09-09). */
  let offenId = $state<string | null>(null);
</script>

<div class="flex flex-col gap-2" data-testid="settings-my-devices">
  {#if eigeneGeraete.length === 0}
    <span class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-xs">
      {m.device_settings_my_devices_empty()}
    </span>
  {:else}
    <ul class="border-border flex flex-col gap-1 rounded-2xl border p-2">
      {#each eigeneGeraete as d (d.id)}
        <li>
          <button
            type="button"
            class="hover:bg-bg-hover flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors"
            onclick={() => (offenId = offenId === d.id ? null : d.id)}
            aria-expanded={offenId === d.id}
            data-testid={`my-device-open-${d.id}`}
          >
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="text-text-bright flex items-center gap-2 truncate text-sm">
                {d.name}
                {#if d.id === diesesGeraetId}
                  <span class="border-border text-text-muted rounded-md border px-1.5 text-2xs" data-testid="my-device-this">
                    {m.device_settings_my_devices_this()}
                  </span>
                {/if}
              </span>
              <span class="text-text-muted flex min-w-0 items-center gap-1.5 truncate text-xs">
                <span class="size-2 shrink-0 rounded-full {punktKlasse(zeileFuer(d).punkt)}" aria-hidden="true"></span>
                {geraetOrtText(d)}
              </span>
            </span>
            <ChevronDownIcon
              class="text-text-muted size-4 shrink-0 transition-transform {offenId === d.id ? 'rotate-180' : ''}"
            />
          </button>
          {#if offenId === d.id}
            <div class="border-border/60 mt-1 border-t pt-2 pl-1">
              <DeviceVerwaltung device={d} />
              <div class="border-border/60 mt-3 border-t pt-3">
                <DeviceFreigaben device={d} eingebettet />
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
