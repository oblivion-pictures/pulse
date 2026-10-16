<!--
  DeviceFreigabeZeilen — die einzelnen Einträge einer Freigabeliste (Nutzer
  und Rollen; „jeder" ist ein Schalter in `DeviceFreigaben`).

  Ausgelagert aus `DeviceFreigaben.svelte` allein wegen der Grössen-Regel
  (2026-10-16, als der Hinweis „sieht den Kanal nicht" dazukam). Reine
  Anzeige: Namen, Geltung und ob ein Eintrag wirkt, rechnet der Aufrufer;
  `data-testid`s wortgleich zu vorher.
-->
<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import type { Grant } from '$lib/api/devices';

  let {
    eintraege,
    name,
    geltung,
    wirkt,
    onEntfernen,
  }: {
    eintraege: Grant[];
    name: (g: Grant) => string;
    geltung: (g: Grant) => string;
    /** Sieht der Eingetragene den Standplatz? Sonst wirkt die Freigabe nicht. */
    wirkt: (g: Grant) => boolean;
    onEntfernen: (g: Grant) => void;
  } = $props();
</script>

<ul class="flex flex-col gap-1.5">
  {#each eintraege as grant (grant.id)}
    <li class="border-border/60 flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5">
      <div class="flex min-w-0 flex-col">
        <span class="text-text-bright truncate text-sm">
          {name(grant)}
          {#if grant.subject_type === 'role'}
            <span class="text-text-muted text-xs">· {m.device_grants_role_suffix()}</span>
          {/if}
          {#if !wirkt(grant)}
            <span class="text-xs text-amber-500" data-testid="device-grant-sieht-nicht">
              · {m.device_grants_sieht_nicht()}
            </span>
          {/if}
        </span>
        <span class="text-text-muted text-xs">{geltung(grant)}</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        class="size-6 shrink-0"
        onclick={() => onEntfernen(grant)}
        data-testid="device-grant-remove"
        aria-label={m.device_grants_remove_aria()}
      >
        <XIcon class="size-3.5" />
      </Button>
    </li>
  {/each}
</ul>
