/**
 * Composer-side two-phase upload helper — **der KLARTEXT-Weg**. Der
 * verschluesselte Gegenpart steht in `uploadVerschluesselt.ts` und teilt sich
 * mit dieser Datei `vorschaubild.ts` und `putMitFortschritt.ts`.
 *
 * Each picked/pasted/dropped File becomes a `PendingAttachment` whose
 * state machine walks through queued → uploading → done | error. The
 * machine handles:
 *
 *  - client-side webp thumbnail generation for image/* (`vorschaubild.ts`),
 *  - presigned-URL request to chat-gateway,
 *  - XHR PUT to MinIO (`putMitFortschritt.ts`),
 *  - cancellation via XHR abort,
 *  - cleanup of object URLs created for the preview thumbnail.
 *
 * Lives outside MessageInput.svelte so the component itself stays
 * presentational and under the 250-line cap.
 */

import { chatApi } from '$lib/api/chat';
import { aufnahmeDauerRegister } from './aufnahmeKern';
import { erzeugeVorschaubild } from './vorschaubild';
import { ticketAnfordern, vorschauBehalten } from './vorschauWahl';
import { putMitFortschritt } from './putMitFortschritt';
import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';

export type PendingAttachment = {
  /** Stable local id (different from the server-assigned attachment.id). */
  localId: string;
  file: File;
  /** Object URL for the in-composer preview; revoke on cleanup. */
  previewUrl: string | null;
  state: 'queued' | 'uploading' | 'done' | 'error';
  progress: number; // 0-100
  /** Set when state transitions to 'done'. */
  attachmentId: string | null;
  errorMessage: string | null;
  /** Gemessene Dauer in Sekunden — NUR bei Sprachnachrichten gesetzt
   *  (Register aus `aufnahmeKern.ts`), denn der WebM-Container traegt keine
   *  brauchbare Dauer und die Vorschau-Leiste soll sie nicht erraten. */
  aufnahmeDauer: number | null;
  /** Nur im VERSCHLUESSELTEN Weg gesetzt (`uploadVerschluesselt.ts`): alles,
   *  was in die verschluesselte Nachricht mitmuss — Dateischluessel, Name,
   *  Typ, Maße. Im Klartext-Weg bleibt es `null`, dort kennt der Server das
   *  alles selbst. */
  anhang: AnhangAngabe | null;
};

let _idCounter = 0;
/** Stabile lokale Zeilen-ID. Exportiert, weil der verschluesselte Weg
 *  (`uploadVerschluesselt.ts`) dieselbe Zeilenform fuellt — zwei Zaehler
 *  koennten dieselbe ID zweimal vergeben, und `pending` sucht darueber. */
export function nextLocalId(): string {
  return `pa-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`;
}

/**
 * Drive an attachment all the way from "file picked" to "server-bound id".
 * `onChange` is called whenever the row's state mutates so the caller's
 * Svelte rune updates re-render the preview strip.
 *
 * Returns an `abort` function the caller can call to cancel in-flight
 * uploads (X-button on the preview tile).
 */
export function startUpload(
  channelId: string,
  file: File,
  onChange: (next: PendingAttachment) => void
): { row: PendingAttachment; abort: () => void } {
  const localId = nextLocalId();
  // Objekt-URL fuer Bild-VORSCHAU, Audio- und Video-VORSCHAU gleichermaßen —
  // die Bereinigung laeuft ueber denselben bestehenden Pfad.
  const previewUrl =
    file.type.startsWith('image/') ||
    file.type.startsWith('audio/') ||
    file.type.startsWith('video/')
      ? URL.createObjectURL(file)
      : null;
  const row: PendingAttachment = {
    localId,
    file,
    previewUrl,
    state: 'queued',
    progress: 0,
    attachmentId: null,
    errorMessage: null,
    aufnahmeDauer: aufnahmeDauerRegister.get(file) ?? null,
    anhang: null
  };

  let abortCurrent: (() => void) | null = null;
  let cancelled = false;

  const emit = () => onChange({ ...row });

  const run = async () => {
    try {
      // 1. (image only) build the thumbnail + capture original dimensions.
      //    Die Maße bleiben auch dann, wenn das Vorschaubild nicht mitgeht:
      //    ein Vorschaubild über der Serverlinie lassen wir weg und laden nur
      //    die Datei hoch (s. vorschauWahl.ts).
      const erzeugt = await erzeugeVorschaubild(file);
      const thumb = erzeugt && vorschauBehalten(erzeugt.blob.size) ? erzeugt : null;
      if (cancelled) return;

      // 2. Ask the server for an upload URL (+ optional thumb URL). Lehnt der
      //    Server nur das Vorschaubild ab (kleine Dateigrenze der Community),
      //    fragt `ticketAnfordern` einmal ohne es neu.
      const { antwort: presign, mitVorschau } = await ticketAnfordern(
        (mitThumb) =>
          chatApi.requestAttachmentUploadUrl(channelId, {
            filename: file.name,
            mime: file.type || 'application/octet-stream',
            size: file.size,
            width: erzeugt?.origWidth,
            height: erzeugt?.origHeight,
            has_thumb: mitThumb,
            thumb_size: mitThumb ? thumb?.blob.size : undefined,
            thumb_width: mitThumb ? thumb?.thumbWidth : undefined,
            thumb_height: mitThumb ? thumb?.thumbHeight : undefined
          }),
        thumb !== null
      );
      if (cancelled) return;

      row.attachmentId = presign.id;
      row.state = 'uploading';
      emit();

      // 3. PUT the bytes — main file first, then the thumb in parallel
      //    isn't worth the bookkeeping; serial keeps the progress meter
      //    monotonic and simple.
      await putMitFortschritt(
        presign.upload_url,
        file,
        file.type || 'application/octet-stream',
        (pct) => {
          row.progress = pct;
          emit();
        },
        (a) => {
          abortCurrent = a;
        }
      );
      if (cancelled) return;

      if (mitVorschau && thumb && presign.thumb_upload_url) {
        await putMitFortschritt(
          presign.thumb_upload_url,
          thumb.blob,
          'image/webp',
          () => {
            /* thumbs are small; ignore intermediate progress */
          },
          (a) => {
            abortCurrent = a;
          }
        );
      }

      if (cancelled) return;
      row.state = 'done';
      row.progress = 100;
      emit();
    } catch (err) {
      if (cancelled) return;
      row.state = 'error';
      row.errorMessage = err instanceof Error ? err.message : String(err);
      emit();
    }
  };

  void run();

  return {
    row,
    abort: () => {
      cancelled = true;
      abortCurrent?.();
      if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
    }
  };
}

export function cleanupRow(row: PendingAttachment): void {
  if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
}
