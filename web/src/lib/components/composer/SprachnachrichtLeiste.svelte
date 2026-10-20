<script lang="ts">
  // Sprachnachricht IM Eingabekasten, Handy und Rechner (Entwurf 2026-10-20):
  // während der Aufnahme Verwerfen, Pause/Weiter, Zeit und roter Stopp; nach
  // dem Stopp die Vorschau mit Abspielen, Verwerfen und Senden. Zustand und
  // Datei liegen in `SprachAufnahme`; hier wohnt nur das Abspielen.
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';
  import PauseIcon from '@lucide/svelte/icons/pause';
  import PlayIcon from '@lucide/svelte/icons/play';
  import { m } from '$lib/paraglide/messages.js';
  import type { SprachAufnahme } from '$lib/attachments/sprachAufnahme.svelte';
  import { formatiereDauer } from '$lib/attachments/aufnahmeKern';

  let {
    aufnahme,
    onSenden
  }: {
    aufnahme: SprachAufnahme;
    /** „Senden" in der Vorschau — die Datei geht in den Anhang-Weg. */
    onSenden: (datei: File) => void;
  } = $props();

  let spielt = $state(false);
  let position = $state(0);
  let audio: HTMLAudioElement | null = null;

  // Ein Audio-Element je Vorschau. Das Aufräumen hält es an, wenn die Vorschau
  // verschwindet (Senden, Verwerfen, Gesprächswechsel) — sonst spielte es im
  // Hintergrund weiter.
  $effect(() => {
    const url = aufnahme.vorschau?.url;
    if (!url) return;
    const a = new Audio(url);
    a.ontimeupdate = () => (position = a.currentTime);
    a.onended = () => (spielt = false);
    audio = a;
    position = 0;
    spielt = false;
    return () => {
      a.pause();
      audio = null;
    };
  });

  function umschalten(): void {
    if (!audio) return;
    if (spielt) {
      audio.pause();
      spielt = false;
    } else {
      spielt = true;
      void audio.play().catch(() => (spielt = false));
    }
  }

  function senden(): void {
    const datei = aufnahme.vorschauNehmen();
    if (datei) onSenden(datei);
  }
</script>

{#if aufnahme.lauf}
  <div class="flex min-h-11 w-full items-center gap-2 nicht-handy:min-h-9" data-testid="aufnahme-leiste">
    <button
      type="button"
      class="text-destructive hover:bg-bg-hover flex size-11 shrink-0 items-center justify-center rounded-full nicht-handy:size-9"
      onclick={() => aufnahme.verwerfen()}
      aria-label={m.message_input_recording_discard()}
      data-testid="aufnahme-verwerfen"
    >
      <Trash2Icon class="size-5" />
    </button>
    <button
      type="button"
      class="text-primary hover:bg-bg-hover flex size-11 shrink-0 items-center justify-center rounded-full nicht-handy:size-9"
      onclick={() => (aufnahme.pausiert ? aufnahme.weiter() : aufnahme.pausieren())}
      aria-label={aufnahme.pausiert
        ? m.message_input_recording_weiter()
        : m.message_input_recording_pause()}
      data-testid="aufnahme-pause"
    >
      {#if aufnahme.pausiert}
        <PlayIcon class="size-5" />
      {:else}
        <PauseIcon class="size-5" />
      {/if}
    </button>
    <span
      class="text-destructive flex items-center gap-1.5 text-sm font-semibold tabular-nums"
      data-testid="aufnahme-zeit"
    >
      <span class="bg-destructive size-2 rounded-full {aufnahme.pausiert ? '' : 'animate-pulse'}"></span>
      {aufnahme.dauer}
    </span>
    <span class="flex-1"></span>
    <!-- Weisses Quadrat auf festem Rot: in beiden Erscheinungsbildern gleich
         gut zu sehen, deshalb hier kein Theme-Wert. -->
    <button
      type="button"
      class="bg-destructive shadow-destructive/50 flex size-11 shrink-0 items-center justify-center rounded-lg shadow-md nicht-handy:size-9"
      onclick={() => void aufnahme.zurVorschau()}
      aria-label={m.message_input_recording_stop()}
      data-testid="aufnahme-stop"
    >
      <span class="block size-3.5 rounded-[2px] bg-white"></span>
    </button>
  </div>
{:else if aufnahme.vorschau}
  {@const v = aufnahme.vorschau}
  <div class="flex min-h-11 w-full items-center gap-2 nicht-handy:min-h-9" data-testid="sprachvorschau">
    <button
      type="button"
      class="text-destructive hover:bg-bg-hover flex size-11 shrink-0 items-center justify-center rounded-full nicht-handy:size-9"
      onclick={() => aufnahme.verwerfen()}
      aria-label={m.message_input_recording_discard()}
      data-testid="sprachvorschau-verwerfen"
    >
      <Trash2Icon class="size-5" />
    </button>
    <button
      type="button"
      class="text-primary bg-bg-hover flex size-11 shrink-0 items-center justify-center rounded-full nicht-handy:size-9"
      onclick={umschalten}
      aria-label={spielt ? m.message_input_recording_pause() : m.message_input_recording_play()}
      data-testid="sprachvorschau-play"
    >
      {#if spielt}
        <PauseIcon class="size-5" />
      {:else}
        <PlayIcon class="size-5" />
      {/if}
    </button>
    <div class="bg-bg-hover h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
      <div
        class="bg-primary h-full rounded-full transition-[width] duration-150"
        style="width: {Math.min(100, (position / Math.max(1, v.sekunden)) * 100)}%"
      ></div>
    </div>
    <span class="text-text-muted shrink-0 font-mono text-2xs tabular-nums">
      {formatiereDauer(position)} / {formatiereDauer(v.sekunden)}
    </span>
    <button
      type="button"
      class="text-primary hover:bg-bg-hover flex size-11 shrink-0 items-center justify-center rounded-full nicht-handy:size-9"
      onclick={senden}
      aria-label={m.message_input_send()}
      data-testid="sprachvorschau-senden"
    >
      <SendHorizontalIcon class="size-5" />
    </button>
  </div>
{/if}
