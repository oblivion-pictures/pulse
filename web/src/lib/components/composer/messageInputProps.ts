import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';

/** Die Props von `MessageInput.svelte`, je Feld dokumentiert. */
export interface MessageInputProps {
  channelId?: string | null;
  placeholder?: string;
  onSend: (
    text: string,
    attachmentIds: string[],
    anhaenge: AnhangAngabe[],
    melden?: (ok: boolean) => void
  ) => void;
  /** Entscheidung 3.4 (2026-09-21): wenn gesetzt, leert sich der Composer
   *  NICHT mehr optimistisch — der Aufrufer meldet das Ergebnis (true =
   *  raus, false = fehlgeschlagen) und der Inhalt bleibt bei false stehen
   *  (Antwort-Kontext inklusive). Nur der verschlüsselte DM-Weg nutzt das;
   *  Anhänge sind bei einem Fehlversuch trotzdem verbraucht (Schlüssel
   *  verbraucht) — dafür gibt es den klaren Hinweis. */
  sendReport?: boolean;
  /** Fired (cheaply, on every keystroke with non-empty content) so the
   *  parent can broadcast a debounced "typing" signal. Optional — the
   *  stream/watch-party chat composer doesn't wire it. */
  onTyping?: () => void;
  replyTo?: { id: string; author: string; snippet: string } | null;
  onCancelReply?: () => void;
  /** When false, this composer skips its own drag-drop (overlay + handlers)
   *  because a parent owns a wider drop zone (ChatView makes the whole
   *  channel droppable and forwards files via `addExternalFiles`). Default
   *  true keeps the standalone stream/watch-party chat composer droppable. */
  handleDrop?: boolean;
  /** When true the input, attachment button and submit are inert. Used
   *  by the DM hard-cut foundation (Etappe 4): DMs without a confirmed
   *  friendship freeze the composer until friendship resumes. The
   *  banner UI lives in Etappe 5 — this prop only locks the form. */
  disabled?: boolean;
  /** Optional explanatory text shown in the input's placeholder when
   *  ``disabled`` is true (otherwise unused). */
  disabledReason?: string;
  /** False → this instance forbids attachments here (Cloud DMs). Removes the
   *  paperclip AND the paste/drop paths — hiding only the button would leave
   *  two working back doors into an endpoint the server 403s anyway. */
  attachmentsAllowed?: boolean;
  /** `accept` list for the file dialog (e.g. `image/*`); empty = anything.
   *  Cosmetic pre-filter only — the server enforces the same allowlist. */
  attachmentAccept?: string;
  /** Ende-zu-Ende-verschluesselter Verfasser (Etappe E): jede Datei wird auf
   *  dem Geraet verschluesselt und ueber die Postfach-Route hochgeladen,
   *  ihr Dateischluessel faehrt in der Nachricht mit. Aendert NUR den
   *  Upload-Weg — Auswahl, Vorschau und Abbruch bleiben identisch. */
  verschluesselt?: boolean;
  /** Zeichenzähler oben statt unten anzeigen lassen: Der Chat hat eine
   *  dauerhaft reservierte Zeile über dem Eingabefeld (Tippanzeige) mit
   *  freiem Platz rechts — der Zähler steht dort, ohne beim Erscheinen
   *  etwas zu verschieben. Der Zähler-Stand geht dann per `zeichenStand`
   *  an den Aufrufer; 0 = nicht sichtbar. Standalone-Verwender (Watch-/
   *  Stream-Chat) lassen beides weg und behalten die eigene Zeile unten. */
  zeichenExtern?: boolean;
  /** Bindable: aktueller Zähler-Stand (0 = unterhalb der Vorwarnzone oder
   *  Limit gilt hier nicht). Nur mit `zeichenExtern` bespielt. */
  zeichenStand?: number;
}
