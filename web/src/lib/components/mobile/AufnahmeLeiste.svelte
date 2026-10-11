<script lang="ts">
  // Laufende Sprachnachricht am Handy: Dauer, „Fertig" und „Verwerfen".
  import SquareIcon from '@lucide/svelte/icons/square';
  import XIcon from '@lucide/svelte/icons/x';
  import { m } from '$lib/paraglide/messages.js';

  let {
    dauer,
    onEnde,
    onVerwerfen
  }: { dauer: string; onEnde: () => void; onVerwerfen: () => void } = $props();
</script>

<!-- Bewusst ABSOLUT über dem Eingabekasten, nicht in der Knopf-
     Reihe: als Flex-Geschwister würde die Leiste die Knöpfe der
     Reihe verschieben (Befund Testrunde 2026-09-11). -->
<div
  class="bg-bg-input/70 absolute bottom-full left-0 right-0 z-30 mb-2 flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 shadow-lg backdrop-blur-lg"
  data-testid="recording-indicator"
>
  <span class="bg-error size-2.5 animate-pulse rounded-full"></span>
  <span class="text-error text-sm font-semibold tabular-nums">
    {dauer}
  </span>
  <span class="flex-1"></span>
  <button
    type="button"
    class="accent-gradient text-primary-foreground flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold shadow-sm"
    onclick={onEnde}
    data-testid="recording-stop"
  >
    <SquareIcon class="size-3.5" />
    {m.message_input_recording_stop()}
  </button>
  <button
    type="button"
    class="bg-bg-panel text-text-muted hover:text-error ml-1 rounded-full border border-border p-1.5 transition-colors"
    onclick={onVerwerfen}
    aria-label={m.message_input_recording_discard()}
    data-testid="recording-discard"
  >
    <XIcon class="size-4" />
  </button>
</div>
