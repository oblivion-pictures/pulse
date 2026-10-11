<script lang="ts">
  // Anhang-Auswahl am Handy (Foto / Galerie / Dokument) — WhatsApp-Prinzip.
  // Ein Tipp auf eine Quelle ruft erst `onClose`, dann deren Rückruf.
  import CameraIcon from '@lucide/svelte/icons/camera';
  import ImageIcon from '@lucide/svelte/icons/image';
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open,
    onClose,
    onKamera,
    onGalerie,
    onDokument
  }: {
    open: boolean;
    onClose: () => void;
    onKamera: () => void;
    onGalerie: () => void;
    onDokument: () => void;
  } = $props();

  const waehle = (quelle: () => void) => () => {
    onClose();
    quelle();
  };
</script>

<BottomSheet
  {open}
  testid="attachment-source-sheet"
  closeLabel={m.message_input_attach_file()}
  panelClass="bg-popover text-popover-foreground relative rounded-t-2xl border-t border-border px-3 pt-2 pb-[calc(1rem+var(--safe-bottom))] shadow-2xl"
  {onClose}
>
  <div class="mx-auto mb-3 mt-1 h-1 w-9 shrink-0 rounded-full bg-border"></div>
  <!-- Drei Kacheln nebeneinander, WhatsApp-Prinzip in Pulse-Farben:
       runder Farbkreis je Quelle, kein Text-Wust. -->
  <div
    class="flex items-stretch justify-center gap-3"
    data-testid="attachment-source-options"
  >
    <button
      type="button"
      class="bg-bg-input hover:bg-bg-hover flex w-24 flex-col items-center gap-2 rounded-2xl border border-border px-2 py-4 transition-colors"
      onclick={waehle(onKamera)}
      data-testid="attachment-source-camera"
    >
      <span
        class="accent-gradient text-primary-foreground flex size-12 items-center justify-center rounded-full"
      >
        <CameraIcon class="size-6" />
      </span>
      <span class="text-xs font-semibold">{m.message_input_anhang_kamera()}</span>
    </button>
    <button
      type="button"
      class="bg-bg-input hover:bg-bg-hover flex w-24 flex-col items-center gap-2 rounded-2xl border border-border px-2 py-4 transition-colors"
      onclick={waehle(onGalerie)}
      data-testid="attachment-source-gallery"
    >
      <span
        class="bg-violet-500/20 text-violet-400 flex size-12 items-center justify-center rounded-full"
      >
        <ImageIcon class="size-6" />
      </span>
      <span class="text-xs font-semibold">{m.message_input_anhang_galerie()}</span>
    </button>
    <button
      type="button"
      class="bg-bg-input hover:bg-bg-hover flex w-24 flex-col items-center gap-2 rounded-2xl border border-border px-2 py-4 transition-colors"
      onclick={waehle(onDokument)}
      data-testid="attachment-source-document"
    >
      <span
        class="bg-sky-500/20 text-sky-400 flex size-12 items-center justify-center rounded-full"
      >
        <FileTextIcon class="size-6" />
      </span>
      <span class="text-xs font-semibold">{m.message_input_anhang_dokument()}</span>
    </button>
  </div>
</BottomSheet>
