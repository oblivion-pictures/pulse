<script lang="ts">
  /**
   * Der Chat-Bildschirm am Handy, solange das Gespräch nicht steht: beim
   * Laden (kurz bei jedem Öffnen) oder nach einem Ladefehler.
   *
   * Die Desktop-Fassung daneben ist eine Fläche neben der Liste und braucht
   * keinen Rückweg. Am Handy verdeckt sie die Liste, die Tab-Leiste ist auf
   * dem Detail-Bildschirm aus — ohne den Pfeil blieb nur die System-Geste,
   * und der Leertext („Wähle links …") zeigte auf eine Liste, die es hier
   * nicht gibt (Bughunt 2026-11-02, Fund 8).
   */
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { fehler, onBack }: { fehler: string | null; onBack: () => void } = $props();
</script>

<section class="glass-panel flex h-full min-w-0 flex-1 flex-col rounded-none" data-testid="dm-handy-platzhalter">
  <header class="bg-popover border-border flex h-14 items-center gap-2.5 border-b px-3">
    <button
      class="text-text-muted hover:text-primary -ml-2 flex min-h-12 min-w-12 shrink-0 items-center justify-center"
      onclick={onBack}
      data-testid="chat-back"
      aria-label={m.chat_view_back()}
    >
      <ChevronLeftIcon class="size-6" />
    </button>
  </header>
  <div class="flex flex-1 flex-col items-center justify-center gap-4 p-8">
    {#if fehler}
      <FieldError message={fehler} testId="load-error" />
    {:else}
      <p class="text-text-muted text-sm">{m.dm_handy_laedt()}</p>
    {/if}
  </div>
</section>
