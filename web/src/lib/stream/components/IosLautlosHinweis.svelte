<!--
  Hinweis auf der Übertragungs-Kachel: „Im Lautlos-Modus ist der Ton der
  Übertragung stumm" — nur in der iOS-Hülle, solange die Hülle das Mikrofon
  hält (nativer Sprachkanal oder Anruf) und die Übertragung eine Tonspur hat.

  **Warum er nötig ist.** Solange ein nativer Raum steht, erklärt sich WebKit
  als `ambient` (`webSessionTyp` in `platform/iosSprache.ts`) — sonst nähme ein
  Oberflächen-Ton der Hülle die Session und damit Hörmuschel und Mikrofon. Eine
  mischbare Session folgt aber dem Stummschalter, und das gilt für die GANZE
  WebView, also auch für den Ton einer HQ-Übertragung (Befund A, 2026-10-17).
  Eine echte Lösung (Übertragungs-Ton nativ in den Raum mischen) wird getrennt
  geplant; bis dahin ist der Hinweis ehrlich.

  Im selbst gebauten Vollbild (`data-eigenes-vollbild` an der Kachel) steht
  keiner der beiden Hinweise: das Bild gehört dort dem Stream, und die Pille
  läge unter der Dynamic Island.

  Desktop und Android sehen ihn nie: `mikrofonBeiDerHuelle()` ist dort immer
  `false`.

  **Mit nativem Stream-Ton (`nativ`, neuer Bau) entfällt er**: der Ton spielt
  dann in der Hülle und folgt dem Stummschalter nicht. Stattdessen sagt die
  Kachel, wenn er abgesenkt wird — offenes Mikrofon am eingebauten
  Lautsprecher, damit der Kanal ihn nicht mithört (`nativerStreamTon.ts`).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import Volume1Icon from '@lucide/svelte/icons/volume-1';
  import type { NativStand } from '../nativerStreamTon';
  import { m } from '$lib/paraglide/messages.js';
  import {
    mikrofonBeiDerHuelle,
    mikrofonBeiDerHuelleBeobachten
  } from '$lib/platform/mikrofonBeiDerHuelle';
  import { isCapacitorIOS } from '$lib/platform/runtime';

  let { stream, nativ = null }: { stream: MediaStream | null; nativ?: NativStand | null } =
    $props();

  let beiDerHuelle = $state(isCapacitorIOS() && mikrofonBeiDerHuelle());
  const abmelden = isCapacitorIOS()
    ? mikrofonBeiDerHuelleBeobachten((an) => (beiDerHuelle = an))
    : () => undefined;
  onDestroy(abmelden);

  const mitTon = $derived((stream?.getAudioTracks().length ?? 0) > 0);
</script>

{#if nativ}
  {#if nativ.echoGedaempft && mitTon}
    <div
      class="pointer-events-none absolute left-1/2 top-2 z-10 flex max-w-[90%] in-data-[eigenes-vollbild]:hidden -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs text-white/90"
      data-testid="hq-stream-ios-echo"
    >
      <Volume1Icon class="size-3.5 shrink-0" />
      <span class="truncate">{m.stream_ios_echo_hinweis()}</span>
    </div>
  {/if}
{:else if beiDerHuelle && mitTon}
  <div
    class="pointer-events-none absolute left-1/2 top-2 z-10 flex max-w-[90%] in-data-[eigenes-vollbild]:hidden -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs text-white/90"
    data-testid="hq-stream-ios-lautlos"
  >
    <VolumeXIcon class="size-3.5 shrink-0" />
    <span class="truncate">{m.stream_ios_lautlos_hinweis()}</span>
  </div>
{/if}
