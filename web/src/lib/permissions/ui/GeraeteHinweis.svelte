<!--
  GeraeteHinweis — auf der Kanalrechte-Seite eines Sprachkanals, in dem
  Remote-Rechner stehen: wer dort was festlegt.

  **Warum es den Hinweis braucht** (seit 2026-10-16): die Zeile „Fernsteuerung
  anfragen" sieht aus, als regle sie die Rechner im Kanal — tut sie aber nicht
  mehr. Wer einen Remote-Rechner steuern darf, legt allein sein Besitzer in der
  Freigabeliste fest; die Kanalrechte bestimmen nur, wer den Kanal sieht und
  damit zusehen kann, solange jemand steuert. Steht kein Gerät im Kanal, gibt
  es nichts zu erklären.

  Die Geräteliste kommt aus demselben Speicher wie die Kanalliste; wer diese
  Seite öffnen darf, sieht den Kanal und damit auch seine Geräte.
-->
<script lang="ts">
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    guildId,
    channelId,
    sprachkanal
  }: { guildId: string; channelId: string; sprachkanal: boolean } = $props();

  $effect(() => {
    if (sprachkanal) void deviceStore.ensureLoaded(guildId);
  });

  const geraete = $derived(
    sprachkanal ? deviceStore.forGuild(guildId).filter((d) => d.channel_id === channelId) : []
  );
  const namen = $derived(geraete.map((d) => d.name).join(', '));
</script>

{#if geraete.length > 0}
  <p
    class="border-border bg-bg-input/40 text-text-base mb-4 flex items-start gap-2 rounded-lg border p-3 text-xs"
    data-testid="perm-geraete-hinweis"
  >
    <MonitorIcon class="text-text-muted mt-0.5 size-4 shrink-0" />
    <span>
      {geraete.length === 1
        ? m.kanalrechte_geraete_hinweis_one({ namen })
        : m.kanalrechte_geraete_hinweis({ count: geraete.length, namen })}
    </span>
  </p>
{/if}
