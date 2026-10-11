<!--
  EckfensterSteuerung — die Knöpfe, die ein Tipp auf das Web-Eckfenster
  (`WatchBackgroundFrame`, Ecken-Modus) einblendet: Schliessen oben links,
  zurück zum Kanal unten rechts und, wo es trägt, das System-Bild-in-Bild
  oben rechts (iOS-Roadmap Punkt 29).

  **Das Bild-in-Bild sitzt gerade HIER richtig:** das Eckfenster entsteht,
  wenn man den Kanal verlässt — und genau dann will man das Bild auch über
  andere Apps mitnehmen. Ein Fenster des Systems bleibt stehen, wenn die App
  in den Hintergrund geht; das Eckfenster nicht.

  `pointer-events-none` auf der Ebene, `auto` auf den Knöpfen — so bleibt der
  abgedunkelte Grund durchlässig: bei Touch zählt ein Tipp darauf weiter als
  Tipp auf die Greiffläche, mit Maus bleibt die Bedienleiste der Kachel
  darunter klickbar.
-->
<script lang="ts">
  import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
  import XIcon from '@lucide/svelte/icons/x';
  import { m } from '$lib/paraglide/messages.js';
  import BildImBildKnopf from '$lib/stream/components/BildImBildKnopf.svelte';

  let {
    onReturn,
    onClose,
    /** Das Video im Eckfenster, falls es eines gibt (eine Watch-Party spielt
     *  in einem iframe — dort gibt es keinen Bild-in-Bild-Knopf). */
    video,
    /** Steuerung ausblenden — nach jedem Druck. */
    ausblenden
  }: {
    onReturn: () => void;
    onClose?: () => void;
    video: HTMLVideoElement | null;
    ausblenden: () => void;
  } = $props();

  const KNOPF =
    'pointer-events-auto absolute z-20 flex size-9 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80';
</script>

<div class="pointer-events-none absolute inset-0 z-20 bg-black/40">
  <!-- Schließen oben links -->
  {#if onClose}
    <button
      type="button"
      class="{KNOPF} top-1 left-1"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={() => {
        ausblenden();
        onClose?.();
      }}
      data-testid="pip-close"
      aria-label={m.tile_shell_hide_tile()}
      title={m.tile_shell_hide_tile()}
    >
      <XIcon class="size-4" />
    </button>
  {/if}
  <!-- System-Bild-in-Bild oben rechts — erscheint nur, wo es trägt -->
  <BildImBildKnopf
    {video}
    klasse="{KNOPF} top-1 right-1"
    symbol="size-4"
    testid="pip-system"
    gedrueckt={ausblenden}
  />
  <!-- Vollbild (zurück zum Kanal) unten rechts -->
  <button
    type="button"
    class="{KNOPF} right-1 bottom-1"
    onpointerdown={(e) => e.stopPropagation()}
    onclick={() => {
      ausblenden();
      onReturn();
    }}
    data-testid="pip-return"
    aria-label={m.watch_pip_return()}
    title={m.watch_pip_return()}
  >
    <Maximize2Icon class="size-4" />
  </button>
</div>
