<script lang="ts">
  // Die Anhang-Eingänge des Verfassers: Datei-Dialog, Büroklammer-Knopf und —
  // nur am Handy — Galerie, Quellen-Blatt und Kamera. Die Sprachnachricht hat
  // ihre eigene Leiste im Eingabekasten (`SprachnachrichtLeiste.svelte`).
  // Welche Dateien daraus werden, entscheidet der Verfasser (`onDateien`).
  import { Button } from '$lib/components/ui/button/index.js';
  import PaperclipIcon from '@lucide/svelte/icons/paperclip';
  import AnhangQuellenBlatt from '$lib/components/mobile/AnhangQuellenBlatt.svelte';
  import KameraOverlay from '$lib/components/mobile/KameraOverlay.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { toast } from 'svelte-sonner';
  import { cleanupRow, startUpload } from '$lib/attachments/upload.svelte';
  import { startUploadVerschluesselt } from '$lib/attachments/uploadVerschluesselt';
  import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';
  import { haptikTicken } from '$lib/platform/haptik';

  let {
    aktiv,
    handy,
    channelId,
    verschluesselt,
    accept,
    onDateien,
    onSend
  }: {
    /** Datei-Eingabe und Büroklammer erscheinen nur, wenn Anhänge hier gehen. */
    aktiv: boolean;
    handy: boolean;
    channelId: string | null;
    /** Derselbe Weg wie jeder andere Anhang dieses Verfassers
     *  (`verfasserZeilen.svelte.ts`): verschlüsselt nur in DMs, Gruppen und
     *  Ablage — ein Community-Kanal nimmt nur den Klartext-Upload an. */
    verschluesselt: boolean;
    accept: string;
    onDateien: (files: FileList | File[]) => void;
    onSend: (text: string, attachmentIds: string[], anhaenge: AnhangAngabe[]) => void;
  } = $props();

  let fileInput: HTMLInputElement | undefined = $state();
  let galleryInput: HTMLInputElement | undefined = $state();
  /** Anhang-Auswahl am Handy (Foto/Galerie/Dokument) — WhatsApp-Prinzip,
   *  drei verborgene Datei-Eingaben dahinter. */
  let anhangSheet = $state(false);
  let videoOverlay = $state(false);
  /** Wahr, während ein Kamera-Video hochgeladen und gesendet wird. */
  let videoSendelauf = $state(false);

  /** Kamera-Entwurf (Foto oder Video aus dem Overlay) DIREKT senden:
   *  hochladen, auf Fertigstellung warten, als Nachricht raus — ganz ohne
   *  Entwurf in der Anhang-Leiste (Testrunde 2026-09-23). Mit Beizeile
   *  (WhatsApp-Prinzip): der Text aus der Vorschau geht als Nachricht mit. */
  async function sendeKameraDirekt(datei: File, text: string): Promise<void> {
    if (!channelId) return;
    videoSendelauf = true;
    let ladung: ReturnType<typeof startUpload> | undefined;
    try {
      const starte = verschluesselt ? startUploadVerschluesselt : startUpload;
      const lauf = starte(channelId, datei, () => {});
      ladung = lauf;
      await new Promise<void>((resolve) => {
        const uhr = setInterval(() => {
          if (lauf.row.state === 'done' || lauf.row.state === 'error') {
            clearInterval(uhr);
            resolve();
          }
        }, 200);
      });
      const { state, attachmentId, anhang, errorMessage } = lauf.row;
      // Der Upload ist gescheitert, nicht die Kamera — die Aufnahme liegt
      // noch im Overlay und lässt sich erneut senden.
      if (state === 'error' || !attachmentId || (verschluesselt && !anhang)) {
        toast.error(m.kamera_senden_fehlgeschlagen(), { description: errorMessage ?? undefined });
        return;
      }
      onSend(text, [attachmentId], anhang ? [anhang] : []);
      videoOverlay = false;
    } finally {
      videoSendelauf = false;
      // Nur die Vorschau-URL freigeben — wie `nachDemSenden` im normalen Weg.
      if (ladung) cleanupRow(ladung.row);
    }
  }

  const onFilePick = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) onDateien(input.files);
    input.value = ''; // allow re-selecting the same file later
  };
</script>

{#if aktiv}
  <input
    type="file"
    multiple
    accept={accept || undefined}
    bind:this={fileInput}
    onchange={onFilePick}
    class="sr-only"
    data-testid="attachment-file-input"
  />
  <!-- Kamera-Aufnahme (mobil): `capture` öffnet auf Android/iOS direkt die
       Kamera-App statt des Datei-Pickers; das geschossene Foto läuft durch
       dieselbe Upload-Pipeline wie ein gewähltes. Nur auf dem Handy — am
       Rechner wäre der Knopf nur ein zweiter Datei-Dialog. -->
  {#if handy}
    <!-- Zwei verborgene Eingaben hinter dem EINEN Büroklammer-Knopf:
         Galerie (Bilder) und Dokumente. Die Kamera läuft über das
         NATIVE Kamera (VideoCapturePlugin) — das <input capture> wurde von
         Android-16-Systempickern geschluckt (Testrunde 2026-09-11). -->
    <input
      type="file"
      accept="image/*"
      bind:this={galleryInput}
      onchange={onFilePick}
      class="sr-only"
      data-testid="attachment-gallery-input"
    />
  {/if}
  <Button
    variant="ghost"
    size="icon"
    class="size-11 nicht-handy:size-9"
    aria-label={m.message_input_attach_file()}
    onclick={() => {
      // Am Handy: Auswahl-Blatt (Foto / Galerie / Dokument). Am Rechner
      // bleibt der direkte Datei-Dialog — dort gibt es keine Kamera-App
      // und eine Galerie-Trennung wäre nur Umwege.
      if (handy) {
        haptikTicken(); // Blatt geht auf — kurzer Tick (mobil)
        anhangSheet = true;
      } else fileInput?.click();
    }}
    data-testid="attachment-button"
  >
    <PaperclipIcon class="size-5" />
  </Button>
{/if}
{#if handy}
  <AnhangQuellenBlatt
    open={anhangSheet}
    onClose={() => (anhangSheet = false)}
    onKamera={() => (videoOverlay = true)}
    onGalerie={() => galleryInput?.click()}
    onDokument={() => fileInput?.click()}
  />
{/if}
{#if handy}
  <KameraOverlay
    open={videoOverlay}
    sendeLaeuft={videoSendelauf}
    onClose={() => (videoOverlay = false)}
    onSend={(datei, text) => void sendeKameraDirekt(datei, text)}
  />
{/if}
