<script lang="ts">
  /**
   * Video groß aus der Medienübersicht (Nutzerwunsch 2026-10-19): schwarz,
   * mit Blättern durch alle Videos des Chats — Pfeile, Wischen oder die
   * Pfeiltasten. Schließen über ✕ oder Esc.
   *
   * **Im Portal und über dem Blatt** (`z-[60]` wie die Lightbox): das Blatt
   * der Medienübersicht hängt selbst per Portal am Ende von `body` (z-50);
   * ohne eigenes Portal und höhere Ebene lag der Betrachter darunter.
   *
   * Verschlüsselte Videos lädt erst der Betrachter, und nur das gezeigte —
   * die Übersicht holt dafür keine Bytes (sonst lüde schon das Öffnen der
   * Galerie jedes Video des Gesprächs).
   */
  import { Portal } from 'bits-ui';
  import XIcon from '@lucide/svelte/icons/x';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import type { Attachment } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import { isIosWebKit } from '$lib/platform/runtime';

  let {
    videos,
    index = $bindable()
  }: {
    videos: Attachment[];
    /** Position im Video-Array; null = geschlossen. */
    index: number | null;
  } = $props();

  const aktuell = $derived(index === null ? null : (videos[index] ?? null));
  let quelle = $state<string | null>(null);
  let spieler: HTMLVideoElement | undefined = $state();

  $effect(() => {
    const a = aktuell;
    quelle = null;
    if (!a) return;
    if (!a.verschluesselt) {
      quelle = a.url;
      return;
    }
    const schluessel = a.schluessel;
    if (!schluessel) return;
    let abgebrochen = false;
    let url: string | null = null;
    void (async () => {
      const { anhangBlob } = await import('$lib/krypto/anhangHolen');
      const blob = await anhangBlob(a.id, schluessel, a.mime ?? 'video/mp4', false);
      if (abgebrochen || !blob) return;
      url = URL.createObjectURL(blob);
      quelle = url;
    })();
    return () => {
      abgebrochen = true;
      if (url) URL.revokeObjectURL(url);
    };
  });

  function blaettern(delta: number): void {
    if (index === null) return;
    const neu = index + delta;
    if (neu >= 0 && neu < videos.length) index = neu;
  }

  function schliessen(): void {
    // iOS: ein Video mit Quelle bleibt bei WebKit als „Jetzt läuft" stehen,
    // auch abgehängt — erst ohne Quelle gibt WebKit es frei (wie im
    // Betrachter von `MessageAttachments`).
    if (isIosWebKit() && spieler) {
      spieler.pause();
      spieler.removeAttribute('src');
      spieler.load();
    }
    index = null;
  }

  function taste(e: KeyboardEvent): void {
    if (index === null) return;
    if (e.key === 'Escape') schliessen();
    else if (e.key === 'ArrowRight') blaettern(1);
    else if (e.key === 'ArrowLeft') blaettern(-1);
  }

  // Wischen nur mit dem Finger, und nicht auf der Steuerleiste des Videos —
  // dort heißt waagerecht ziehen spulen, nicht blättern.
  let wischStart: number | null = null;
  function zeigerRunter(e: PointerEvent): void {
    wischStart = null;
    if (e.pointerType !== 'touch') return;
    if (spieler && e.target === spieler) {
      const rand = spieler.getBoundingClientRect().bottom;
      if (e.clientY > rand - 64) return;
    }
    wischStart = e.clientX;
  }
  function zeigerHoch(e: PointerEvent): void {
    if (wischStart === null) return;
    const dx = e.clientX - wischStart;
    wischStart = null;
    if (dx <= -60) blaettern(1);
    else if (dx >= 60) blaettern(-1);
  }
</script>

<svelte:window onkeydown={taste} />

{#if aktuell && index !== null}
  <Portal>
    <div
      class="fixed inset-0 z-[60] flex flex-col bg-black"
      data-testid="medien-video-viewer"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label={aktuell.filename ?? m.medien_bild_oeffnen()}
      onpointerdown={zeigerRunter}
      onpointerup={zeigerHoch}
      data-edge-swipe-aus
    >
      <div
        class="flex items-center gap-3 p-4 ios:pt-[max(1rem,var(--safe-top))] ios:pl-[max(1rem,var(--safe-left))] ios:pr-[max(1rem,var(--safe-right))]"
      >
        <button
          type="button"
          class="flex size-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white"
          onclick={schliessen}
          aria-label={m.lightbox_close()}
          data-testid="video-viewer-close"
        >
          <XIcon class="size-5" />
        </button>
        <span class="min-w-0 flex-1 truncate text-sm text-white/80">{aktuell.filename ?? ''}</span>
      </div>
      <div class="flex min-h-0 flex-1 items-center justify-center">
        {#if quelle}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={spieler}
            src={quelle}
            class="max-h-full max-w-full"
            controls
            autoplay
            playsinline
          ></video>
        {:else}
          <span class="size-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80"></span>
        {/if}
      </div>
      <div
        class="flex items-center justify-between px-6 pt-2 pb-[calc(var(--safe-bottom,0px)+12px)] text-white"
      >
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-full bg-white/10 disabled:opacity-30"
          onclick={() => blaettern(-1)}
          disabled={index === 0}
          aria-label={m.attachment_fullscreen_prev()}
          data-testid="video-viewer-prev"
        >
          <ChevronLeftIcon class="size-6" />
        </button>
        <span class="text-xs text-white/60 tabular-nums">{index + 1} / {videos.length}</span>
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-full bg-white/10 disabled:opacity-30"
          onclick={() => blaettern(1)}
          disabled={index === videos.length - 1}
          aria-label={m.attachment_fullscreen_next()}
          data-testid="video-viewer-next"
        >
          <ChevronRightIcon class="size-6" />
        </button>
      </div>
    </div>
  </Portal>
{/if}
