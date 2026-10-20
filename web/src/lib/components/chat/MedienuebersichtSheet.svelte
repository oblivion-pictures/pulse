<script lang="ts">
  /**
   * Medienübersicht pro Chat (Übergabe P1.7): alle Bilder und Dateien der
   * geladenen Unterhaltung in einem Blatt — Bilderraster oben, Dateiliste
   * darunter, Klick öffnet Lightbox bzw. Download.
   *
   * Die Daten kommen aus dem NACHRICHTEN-Store (nicht aus IndexedDB): das
   * Blatt zeigt genau den Verlauf, den der Chat ohnehin kennt — ältere
   * Medien erscheinen, sobald der Nutzer in der Historie zurückscrollt.
   * Verschlüsselte Bilder laufen über `AutoRefreshImage` ( Holt + Objekt-
   * URL, wie in `MessageAttachments`), Dateien über den `quellen`-Effekt
   * mit `anhangBlob`; das Muster ist bewusst dasselbe wie dort.
   */
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import AutoRefreshImage from '$lib/components/AutoRefreshImage.svelte';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import AnhangLadeknopf from '$lib/components/AnhangLadeknopf.svelte';
  import FileIcon from '@lucide/svelte/icons/file';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import type { Attachment, Message } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import { formatBytes } from '$lib/utils/formatBytes';

  let {
    messages,
    open = $bindable(false)
  }: {
    messages: Message[];
    open?: boolean;
  } = $props();

  let quellen = $state<Record<string, string>>({});

  const alleAnhaenge = $derived(messages.flatMap((n) => n.attachments ?? []));
  /** Galerie (Nutzerwunsch 2026-10-19): Bilder UND Videos als Kacheln —
   *  Videos vorher in der Dateiliste „zum Herunterladen“ war nicht das,
   *  was man von einer Galerie erwartet. */
  const medien = $derived(
    alleAnhaenge.filter((a) => {
      const mime = a.mime ?? '';
      return mime.startsWith('image/') || mime.startsWith('video/');
    })
  );
  const dateien = $derived(
    alleAnhaenge.filter((a) => {
      const mime = a.mime ?? '';
      return !mime.startsWith('image/') && !mime.startsWith('video/');
    })
  );
  /** Verschlüsseltes ohne Bild-Kanal (Videos + Dateien): die Bytes kommen
   *  per Blob in eine Objekt-URL — Videos daraus direkt im Raster
   *  abspielbar, Dateien als Download. */
  const verschluesselteOhneBild = $derived([
    ...dateien.filter((a) => a.verschluesselt),
    ...medien.filter((a) => a.verschluesselt && (a.mime ?? '').startsWith('video/'))
  ]);
  /** Nur die Videos, in Reihenfolge — der Vollbild-Player blättert darin
   *  (Nutzerwunsch 2026-10-19: Video antippen → groβ, hin- und herblättern
   *  wie bei WhatsApp). */
  const videos = $derived(medien.filter((a) => (a.mime ?? '').startsWith('video/')));
  const videoPosition = $derived(new Map(videos.map((v, i) => [v.id, i])));

  let videoViewer = $state<number | null>(null);
  let wischStart = $state<number | null>(null);

  function videoOeffnen(index: number): void {
    if (index === undefined || index === null) return;
    videoViewer = index;
  }
  function videoViewerZu(): void {
    videoViewer = null;
  }
  function videoBlaettern(delta: number): void {
    if (videoViewer === null || videos.length === 0) return;
    videoViewer = (((videoViewer + delta) % videos.length) + videos.length) % videos.length;
  }
  function viewerZeigerRunter(e: PointerEvent): void {
    wischStart = e.clientX;
  }
  function viewerZeigerHoch(e: PointerEvent): void {
    if (wischStart === null) return;
    const dx = e.clientX - wischStart;
    wischStart = null;
    if (dx <= -60) videoBlaettern(1);
    else if (dx >= 60) videoBlaettern(-1);
  }

  $effect(() => {
    const liste = verschluesselteOhneBild;
    if (liste.length === 0) return;
    let abgebrochen = false;
    const erzeugt: string[] = [];
    const gesammelt: Record<string, string> = {};
    void (async () => {
      const { anhangBlob } = await import('$lib/krypto/anhangHolen');
      for (const a of liste) {
        if (abgebrochen) return;
        const blob = a.schluessel
          ? await anhangBlob(a.id, a.schluessel, a.mime ?? 'application/octet-stream', false)
          : null;
        if (abgebrochen) return;
        const url = blob ? URL.createObjectURL(blob) : '';
        erzeugt.push(url);
        gesammelt[a.id] = url;
        quellen = { ...quellen, ...gesammelt };
      }
    })();
    return () => {
      abgebrochen = true;
      for (const url of erzeugt) URL.revokeObjectURL(url);
      quellen = {};
    };
  });

  let lightboxAnhang = $state<Attachment | null>(null);
  let lightboxOffen = $state(false);

  function bildOeffnen(a: Attachment): void {
    lightboxAnhang = a;
    lightboxOffen = true;
  }

  function dateiQuelle(a: Attachment): string | null {
    if (!a.verschluesselt) return a.url;
    return quellen[a.id] ?? null;
  }
</script>

<BottomSheet
  {open}
  testid="media-sheet"
  closeLabel={m.medien_schliessen()}
  panelClass="bg-popover text-popover-foreground border-border relative flex max-h-[80dvh] flex-col overflow-y-auto rounded-t-[22px] border-t pb-[var(--safe-bottom)] shadow-2xl"
  onClose={() => (open = false)}
>
  <div class="bg-border mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-full"></div>
  <div class="px-4 pb-2" data-testid="media-sheet-body">
    <p class="text-text-bright text-base font-bold">{m.medien_titel()}</p>

    {#if alleAnhaenge.length === 0}
      <p class="text-text-muted py-6 text-center text-xs">{m.medien_leer()}</p>
    {:else}
      {#if medien.length > 0}
        <p class="text-text-muted mt-2 mb-1 text-xs font-bold uppercase">{m.medien_medien()}</p>
        <div class="grid grid-cols-3 gap-1.5">
          {#each medien as a (a.id)}
            {@const istVideo = (a.mime ?? '').startsWith('video/')}
            {#if istVideo}
              <!-- Video-Kachel: Vorschau + Play-Zeichen, Antippen öffnet den
                   Vollbild-Player (Nutzerwunsch 2026-10-19). -->
              <button
                type="button"
                class="relative aspect-square w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-black"
                onclick={() => videoOeffnen(videoPosition.get(a.id) ?? 0)}
                aria-label={a.filename ?? m.medien_bild_oeffnen()}
                data-testid={`media-video-${a.id}`}
              >
                <video
                  src={dateiQuelle(a) ?? a.thumb_url ?? a.url}
                  class="block size-full object-cover opacity-80"
                  preload="metadata"
                  muted
                  playsinline
                ></video>
                <span class="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                  <span class="flex size-9 items-center justify-center rounded-full bg-black/60 text-white">
                    ▶
                  </span>
                </span>
              </button>
            {:else}
              <button
                type="button"
                class="aspect-square relative w-full cursor-zoom-in overflow-hidden rounded-lg border border-border"
                onclick={() => bildOeffnen(a)}
                aria-label={a.filename ?? m.medien_bild_oeffnen()}
                data-testid={`media-image-${a.id}`}
              >
                <AutoRefreshImage
                  attachmentId={a.id}
                  src={a.thumb_url ?? a.url}
                  alt={a.filename ?? ''}
                  thumb={a.verschluesselt
                    ? a.thumb_schluessel !== null && a.thumb_schluessel !== undefined
                    : a.thumb_url !== null && a.thumb_url !== undefined}
                  anhang={a.verschluesselt ? a : null}
                  class="block size-full object-cover"
                />
              </button>
            {/if}
          {/each}
        </div>
      {/if}

      {#if dateien.length > 0}
        <p class="text-text-muted mt-3 mb-1 text-xs font-bold uppercase">{m.medien_dateien()}</p>
        <ul class="flex flex-col gap-1">
          {#each dateien as a (a.id)}
            {@const quelle = dateiQuelle(a)}
            <li
              class="bg-bg-input flex items-center gap-2.5 rounded-xl border border-border px-3 py-2"
              data-testid={`media-file-${a.id}`}
            >
              <FileIcon class="text-text-muted size-4 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="text-text-bright block truncate text-xs font-semibold"
                  >{a.filename ?? m.medien_unbenannt()}</span
                >
                <span class="text-text-muted block text-2xs">{formatBytes(a.size)}</span>
              </span>
              {#if quelle}
                <AnhangLadeknopf
                  {quelle}
                  dateiname={a.filename}
                  class="text-primary hover:bg-bg-hover flex size-8 items-center justify-center rounded-full handy:size-11"
                  aria-label={m.medien_datei_laden()}
                  data-testid={`media-file-download-${a.id}`}
                >
                  <DownloadIcon class="size-4" />
                </AnhangLadeknopf>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</BottomSheet>

{#if lightboxAnhang}
  <Lightbox
    bind:open={lightboxOffen}
    attachmentId={lightboxAnhang.id}
    src={lightboxAnhang.thumb_url ?? lightboxAnhang.url}
    alt={lightboxAnhang.filename ?? ''}
    filename={lightboxAnhang.filename}
    anhang={lightboxAnhang.verschluesselt ? lightboxAnhang : null}
  />
{/if}

{#if videoViewer !== null && videos[videoViewer]}
  {@const a = videos[videoViewer]}
  <!-- Vollbild-Player (Nutzerwunsch 2026-10-19): Video antippen → groβ,
       mit Pfeilen oder Wischen durch die Videos der Gruppe. -->
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events a11y_interactive_supports_focus a11y_media_has_caption -->
  <div
    class="fixed inset-0 z-50 flex flex-col bg-black"
    data-testid="medien-video-viewer"
    tabindex="-1"
    role="dialog"
    onpointerdown={viewerZeigerRunter}
    onpointerup={viewerZeigerHoch}
  >
    <div class="flex items-center justify-between px-4 py-3">
      <span class="min-w-0 flex-1 truncate text-sm text-white/80">{a.filename ?? ''}</span>
      <span class="text-xs text-white/60">{videoViewer + 1}/{videos.length}</span>
    </div>
    <div class="flex min-h-0 flex-1 items-center justify-center">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        src={dateiQuelle(a) ?? a.url}
        class="max-h-full max-w-full"
        controls
        autoplay
        playsinline
      ></video>
    </div>
    <div class="flex items-center justify-between px-6 pb-[calc(var(--safe-bottom,0px)+12px)] pt-2 text-white">
      <button
        type="button"
        class="flex size-11 items-center justify-center rounded-full bg-white/10"
        onclick={() => videoBlaettern(-1)}
        disabled={videoViewer === 0}
        aria-label="Vorheriges Video"
        data-testid="video-viewer-prev"
      >
        ‹
      </button>
      <span class="text-xs text-white/60">{videoViewer + 1} / {videos.length}</span>
      <button
        type="button"
        class="flex size-11 items-center justify-center rounded-full bg-white/10"
        onclick={() => videoBlaettern(1)}
        disabled={videoViewer === videos.length - 1}
        aria-label="Nächstes Video"
        data-testid="video-viewer-next"
      >
        ›
      </button>
    </div>
  </div>
{/if}
