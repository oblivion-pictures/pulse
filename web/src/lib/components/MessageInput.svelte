<script module>
  // Zeichenlimit des Servers (messages.py, ws_op_send.py, watch_/stream_chat.py).
  // Modul-Export, damit ChatView den Zähler in der Tippanzeige-Zeile mit
  // derselben Zahl rendern kann, ohne sie zu duplizieren.
  export const ZEICHEN_LIMIT = 4000;
</script>

<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import ComposerReplyBanner from './composer/ComposerReplyBanner.svelte';
  import ComposerEmojiButton from './composer/ComposerEmojiButton.svelte';
  import ComposerSendButton from './composer/ComposerSendButton.svelte';
  import ComposerAnhaenge from './composer/ComposerAnhaenge.svelte';
  import AttachmentPreviewStrip from './AttachmentPreviewStrip.svelte';
  import MentionTriggerOverlay from './MentionTriggerOverlay.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { expandShortcodes } from '$lib/emoji';
  import { VerfasserAnhaenge } from '$lib/attachments/verfasserZeilen.svelte';
  import { dateienAusEinfuegen } from '$lib/attachments/eingefuegteDateien';
  import { SprachAufnahme } from '$lib/attachments/sprachAufnahme.svelte';
  import { DateiZiehZone } from '$lib/attachments/dateiZiehen.svelte';
  import type { MessageInputProps } from './composer/messageInputProps';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { toast } from 'svelte-sonner';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { lookupComposer } from '$lib/shortcuts/engine.svelte';
  import { applyComposerAction } from '$lib/shortcuts/composerActions';
  import { isElectron } from '$lib/platform/runtime';
  import { haptikTicken } from '$lib/platform/haptik';
  import { sendungGezaehlt } from '$lib/platform/bewertung';
  import { mitteilungenAnfragen } from '$lib/platform/fcm';
  import { canRecoverDroppedFiles } from '$lib/platform/electronFiles';
  import { drafts } from '$lib/stores/drafts.svelte';
  import { untrack } from 'svelte';

  // `channelId` null → watch-party / stream-chat composer: attachments
  // (paperclip / paste / drop) are wired off, mention popup still works.
  let {
    channelId = null,
    placeholder = m.message_input_placeholder(),
    onSend,
    sendReport = false,
    onTyping,
    replyTo = null,
    onCancelReply,
    disabled = false,
    disabledReason = '',
    handleDrop = true,
    attachmentsAllowed = true,
    attachmentAccept = '',
    verschluesselt = false,
    zeichenExtern = false,
    zeichenStand = $bindable(0)
  }: MessageInputProps = $props();

  const attachmentsEnabled = $derived(channelId !== null && attachmentsAllowed);

  let text = $state('');

  // Entwurf je Channel (auch DMs): beim Mount/Channel-Wechsel wiederherstellen,
  // und wenn von aussen etwas eingesetzt wurde (`drafts.einsetzen`, etwa eine
  // nicht gesendete Banner-Antwort im offenen Gespräch, C6) …
  // (untrack: der Effect soll nicht auf spätere Draft-Schreibvorgänge
  // reagieren — sonst würde jeder Tastendruck ihn re-triggern.)
  $effect(() => {
    const id = channelId;
    if (id) drafts.einsetzungen(id);
    text = id ? untrack(() => drafts.get(id)) : '';
  });
  // … und laufend sichern. Leerer Text löscht den Entwurf — damit räumt auch
  // das `text = ''` nach dem Senden den Entwurf automatisch weg. Deklaration
  // NACH dem Restore-Effect: beim Channel-Wechsel läuft erst der Restore,
  // dann sichert dieser Effect den frisch geladenen (unveränderten) Text.
  $effect(() => {
    const id = channelId;
    const t = text;
    if (id) untrack(() => drafts.set(id, t));
  });
  let textarea: HTMLTextAreaElement | undefined = $state();
  /** Ist die Nachrichtenzeile im Fokus? Entscheidet über Mikro- vs.
   *  Senden-Symbol rechts (WhatsApp-Prinzip, Testrunde 2026-09-11). */
  let eingabeFokus = $state(false);

  // Anhang-Zeilen samt Upload-Buchfuehrung — inklusive der Weiche zwischen
  // Klartext- und verschluesseltem Weg (`verfasserZeilen.svelte.ts`).
  const anhaenge = new VerfasserAnhaenge();

  // Leaving the channel (switch or unmount) abandons any in-flight uploads of
  // the previous channel: abort them and revoke their preview object-URLs so a
  // half-finished upload neither lands in a channel we left nor leaks memory.
  //
  // **Der Effekt folgt der KENNUNG, nicht dem Kanal-Objekt** — und das ist
  // keine Feinheit, sondern die Ursache eines stillen Datenverlusts
  // (2026-09-01, gemessen im Hetzner-Nachweis). Bei einer Direktnachricht
  // baut `berechneSynthChannel` bei JEDER Neuberechnung ein frisches
  // `Channel`-Objekt; sie laeuft unter anderem, sobald ein Anzeigename im
  // `userCache` nachgeladen wird — was waehrend eines Uploads regelmaessig
  // passiert. Las dieser Effekt `channelId` direkt, haengte er damit am
  // Objekt und nicht an der Zeichenkette darin: jede Neuberechnung riss ihn
  // ab, sein Aufraeumer brach den laufenden Upload ab, und die Kachel
  // verschwand kommentarlos aus der Leiste — ohne Fehler, ohne Nachricht,
  // mit einer verwaisten Anhang-Zeile beim Server.
  //
  // Ein `$derived` auf denselben Wert bricht die Kette: es rechnet zwar
  // erneut, meldet seine Aenderung aber nur weiter, wenn die Zeichenkette
  // sich wirklich unterscheidet.
  const kanalSchluessel = $derived(channelId);
  $effect(() => {
    void kanalSchluessel; // track so the cleanup runs whenever the channel changes
    return () => anhaenge.alleAbbrechen();
  });

  // Drag&drop file upload. In the Electron desktop app the sandboxed renderer
  // can't read OS-dropped file bytes directly (size 0 → upload 422) — but a
  // current shell exposes a native bridge that recovers them, so drop is enabled
  // when that bridge is present. Older shells (no bridge) stay disabled.
  // `handleDrop` still lets a parent own the zone (ChatView). Browsers: always on.
  const dropEnabled = $derived(
    handleDrop && attachmentsAllowed && (!isElectron() || canRecoverDroppedFiles())
  );
  const ziehen = new DateiZiehZone(() => dropEnabled, (files) => addFiles(files));

  // Mention overlay owns the popup state; we just forward textarea events.
  let mentionOverlay: MentionTriggerOverlay | undefined = $state();

  // DM channels aren't in the store → guildId stays null → autocomplete
  // suppresses role + everyone suggestions.
  const guildId = $derived(channelId ? guilds.guildIdForChannel(channelId) : null);

  // Zeichenlimit 4000: Der Server lehnt längeren Text auf JEDEM Weg ab
  // (messages.py `MessageIn`/`MessageEditIn`, ws_op_send.py Fehlercode 4005,
  // watch_/stream_chat.py `MAX_CONTENT_LEN`). Nur der verschlüsselte DM-Weg
  // (`sendReport`, Postfach mit 256-KB-Umschlägen) kennt es nicht. Ohne
  // Zähler sah der Nutzer das Limit erst am Server-Fehler, nachdem der Text
  // schon im Eingabefeld stand. Gezählt wird die SENDE-Form — Shortcodes
  // expandiert und @Namen im Kabelformat `<@123…>`, das LÄNGER sein kann
  // als der sichtbare Text; `[...s]` zählt Codepoints wie Pythons len().
  const ZEICHEN_WARN_AB = 3600;
  const limitAktiv = $derived(!sendReport);
  const zeichen = $derived.by(() => {
    const value = expandShortcodes(text).trim();
    return [...(mentionOverlay?.toMarkup(value) ?? value)].length;
  });
  const ueberLimit = $derived(limitAktiv && zeichen > ZEICHEN_LIMIT);
  // Stand an den Aufrufer reichen (Chat-Ansicht rendert ihn in der reservierten
  // Tippanzeige-Zeile); 0 = unterhalb der Vorwarnzone oder Limit gilt nicht.
  $effect(() => {
    zeichenStand = limitAktiv && zeichen >= ZEICHEN_WARN_AB ? zeichen : 0;
  });

  // Bughunt Runde 18: Fehlerzeilen blockieren jetzt — vorher ging die
  // Nachricht ohne den fehlgeschlagenen Anhang raus und die Fehlerkachel
  // (einzige Retry-Möglichkeit) verschwand still.
  const sendDisabled = $derived(
    disabled ||
      (text.trim().length === 0 && anhaenge.zeilen.length === 0) ||
      anhaenge.laeuftNoch ||
      anhaenge.hatFehler ||
      ueberLimit
  );
  const effectivePlaceholder = $derived(
    disabled && disabledReason ? disabledReason : placeholder
  );

  function addFiles(files: FileList | File[]): void {
    // Single choke point for every entry path (picker, paste, drop, and the
    // parent's `addExternalFiles`) — guarding here rather than at each call
    // site is what keeps paste/drop from staying live once the button is gone.
    if (!channelId || !attachmentsAllowed) return;
    anhaenge.hinzufuegen(channelId, Array.from(files), verschluesselt);
  }

  /** Entry point for files dropped *outside* the composer — the whole
   *  ChatView is a drop zone (Discord-style), and it forwards the files here
   *  so they land in this composer's pending-upload strip. No-op when
   *  attachments are off (watch-party / stream chat). */
  export function addExternalFiles(files: FileList | File[]): void {
    addFiles(files);
  }

  // ---- Geteilter Inhalt (Übergabe P1.8, Share-Target) -----------------
  // Ein Share aus einer anderen App wird im NÄCHSTEN offenen Composer
  // angewendet: Text vorbefüllt, Bild landet im Anhang-Streifen (und läuft
  // damit durch dieselbe Upload-Pipeline). Verbrauchen = leeren, sonst
  // klebt der Share an jedem später geöffneten Chat.
  async function freigabeUebernehmen(): Promise<void> {
    // Kontext PRÜFEN, dann konsumieren — sonst wäre der Share weg, wenn der
    // Composer ihn gar nicht aufnehmen kann (Kanal ohne Anhänge, kein Chat).
    if (!channelId || !attachmentsAllowed) return;
    const { freigabeHolen, freigabeLeeren } = await import('$lib/freigabe/freigabeStore');
    const paket = freigabeHolen();
    if (!paket) return;
    freigabeLeeren();
    if (paket.text) text = paket.text;
    if (paket.bild) {
      const bytes = Uint8Array.from(atob(paket.bild.base64), (c) => c.charCodeAt(0));
      const datei = new File([bytes], 'geteilt.' + (paket.bild.mime.split('/')[1] ?? 'png'), {
        type: paket.bild.mime
      });
      addFiles([datei]);
    }
    // iOS, mehrere Dateien: erst jetzt aus der Hülle holen, dann durch
    // dieselbe Anhang-Pipeline wie eine gewählte Datei.
    if (paket.paketId && paket.dateien?.length) {
      const startKanal = channelId;
      const { geteilteDateienHolen } = await import('$lib/freigabe/freigabeUebernahme');
      const geladen = await geteilteDateienHolen(
        paket.paketId,
        paket.dateien,
        paket.uebersprungen ?? 0,
        () => channelId === startKanal
      );
      if (geladen.length) addFiles(geladen);
    }
  }

  $effect(() => {
    void freigabeUebernehmen();
    // visibilitychange feuert beim Vordergrund-Wechsel (Share-intent kommt
    // über onNewIntent, kein Seiten-Reload) — dann ist das Paket frisch.
    const beiSichtbar = () => {
      if (document.visibilityState === 'visible') void freigabeUebernehmen();
    };
    document.addEventListener('visibilitychange', beiSichtbar);
    window.addEventListener('pulse-freigabe', beiSichtbar);
    return () => {
      document.removeEventListener('visibilitychange', beiSichtbar);
      window.removeEventListener('pulse-freigabe', beiSichtbar);
    };
  });

  const removeAttachment = (localId: string) => anhaenge.entfernen(localId);

  // Sprachnachricht (P0.3): Zustand und Ticker in `sprachAufnahme.svelte.ts`;
  // die fertige Datei läuft durch denselben Anhang-Weg wie eine gewählte.
  const aufnahme = new SprachAufnahme((datei) => addFiles([datei]));
  async function aufnahmeStart(): Promise<void> {
    if (!channelId || !attachmentsAllowed) return;
    await aufnahme.starten();
  }

  const onPaste = (e: ClipboardEvent) => {
    const dt = e.clipboardData;
    if (!dt) return;
    // Welche Dateien wirklich drinstecken, rechnet `eingefuegteDateien.ts`
    // (importfrei und dort unit-geprueft) — inklusive der Falle mit der
    // 0-Byte-Datei-Referenz im abgeschotteten Electron-Renderer.
    const collected = dateienAusEinfuegen(Array.from(dt.items), Array.from(dt.files));
    if (!collected.length) return; // nothing usable → leave default paste alone
    e.preventDefault(); // don't also drop a path/text into the textarea
    addFiles(collected);
  };

  function fire() {
    if (sendDisabled) return;
    const value = expandShortcodes(text).trim();
    // Convert `@DisplayName` placeholders back to `<@id>` wire format before
    // sending. The overlay tracked each autocomplete insertion; manually typed
    // @-patterns are left as-is (they won't match the tracked display texts).
    const markupValue = mentionOverlay?.toMarkup(value) ?? value;
    const ids = anhaenge.ids;
    if (!markupValue && ids.length === 0) return;
    if (sendReport) {
      // Entscheidung 3.4, fertig verdrahtet (Runde-2-Audit hat den fehlenden
      // Rest gefunden): Inhalt STEHEN LASSEN, bis das Ergebnis da ist. Der
      // 4. Parameter wandert durch ChatView/Seite in dmSenden, das
      // melden(ok) genau einmal ruft.
      const melden = (ok: boolean): void => {
        if (ok) {
          haptikTicken(); // Erst der gemeldete Erfolg tickt — kein Tick bei Fehlversuch
          nachErfolgreichemSenden();
          text = '';
          anhaenge.nachDemSenden();
          mentionOverlay?.clear();
        } else {
          // Anhänge bleiben verbraucht (Dateischlüssel im Umschlag) — aber
          // der Text + Antwort-Kontext bleiben im Composer sichtbar.
          toast.info(m.composer_fehlversuch_anhaenge());
        }
      };
      onSend(markupValue, ids, anhaenge.anhaenge, melden);
      return;
    }
    onSend(markupValue, ids, anhaenge.anhaenge);
    haptikTicken(); // Optimistischer Weg: der Abgang zählt als Erfolg
    nachErfolgreichemSenden();
    text = '';
    anhaenge.nachDemSenden();
    mentionOverlay?.clear();
  }

  /** Zwei Dinge hängen am erfolgreichen Senden, und beide entscheiden selbst,
   *  ob sie dran sind: der Zähler für die Bewertungsfrage (ab 20 Nachrichten,
   *  `bewertungRegel.ts`) und die Frage nach der Mitteilungs-Erlaubnis (schon
   *  ab der ersten Nachricht, mit Vorerklärung — `berechtigungRegel.ts`).
   *
   *  **Warum ausgerechnet hier.** Die Mitteilungs-Erlaubnis wurde vorher beim
   *  START abgefragt, und der iOS-Dialog erscheint genau EINMAL: ein „nein"
   *  aus Reflex war dauerhaft. Nach einer gesendeten Nachricht ist der Nutzen
   *  dagegen offensichtlich — man will wissen, wenn geantwortet wird.
   *
   *  Als gemeinsame Funktion, weil es ZWEI Erfolgswege gibt (gemeldet und
   *  optimistisch) und ein zweiter Aufruf an nur einem von beiden ein stiller
   *  Teilausfall wäre. */
  function nachErfolgreichemSenden(): void {
    sendungGezaehlt();
    void mitteilungenAnfragen();
  }

  function onKeydown(e: KeyboardEvent) {
    if (mentionOverlay?.handleKey(e)) return; // popup gets first dibs on ↑/↓/Enter/Tab/Esc
    const composerAction = lookupComposer(e);
    if (composerAction && textarea && applyComposerAction(composerAction, textarea, text, (v) => (text = v))) {
      e.preventDefault();
      mentionOverlay?.update();
      return;
    }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); onCancelReply?.(); return; }
    // Handy: Return macht einen Zeilenumbruch (der Browser fügt ihn selbst ein,
    // `enterkeyhint="enter"` unten beschriftet die Taste), gesendet wird nur über
    // den Senden-Knopf — die Bildschirmtastatur hat kein Shift+Return, eine
    // mehrzeilige Nachricht wäre sonst unmöglich. Desktop und Tablet: Enter sendet.
    if (viewport.istHandy) return;
    // !e.isComposing: während einer IME-Komposition (CJK) bestätigt Enter den
    // Kandidaten — NICHT senden, sonst ginge der noch nicht committete Text
    // verloren (compositionend feuert erst nach diesem keydown).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); fire(); }
  }

  const onMentionSync = () => mentionOverlay?.update();

  function insertEmoji(emoji: string) {
    const ta = textarea;
    if (!ta) { text = text + emoji; return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    text = text.slice(0, start) + emoji + text.slice(end);
    queueMicrotask(() => { ta.focus(); ta.setSelectionRange(start + emoji.length, start + emoji.length); });
  }

  // Auto-Grow (Discord-Stil): das Eingabefeld wächst mit dem Inhalt mit, statt
  // ihn auf eine Zeile abzuschneiden. `text` als Abhängigkeit deckt JEDEN
  // Änderungspfad ab — Tippen, Einfügen, Emoji, Composer-Aktionen und das
  // Leeren nach dem Senden (dann schrumpft es wieder). Die Höhe wird auf
  // `scrollHeight` gesetzt; das CSS `max-h-40` deckelt sie und lässt darüber
  // scrollen. `height='auto'` zuerst, damit es beim Löschen auch wieder kleiner
  // wird (sonst bliebe der einmal erreichte Maximalwert stehen).
  $effect(() => {
    void text;
    const ta = textarea;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  });
</script>

<form
  class="px-2 pt-2 pb-[calc(1.25rem+var(--safe-bottom))] nicht-handy:px-2 nicht-handy:pb-2"
  ondragenter={ziehen.enter}
  ondragover={ziehen.over}
  ondragleave={ziehen.leave}
  ondrop={ziehen.drop}
  onsubmit={(e) => { e.preventDefault(); fire(); }}
>
  {#if replyTo}
    <ComposerReplyBanner {replyTo} onCancel={onCancelReply} />
  {/if}

  <AttachmentPreviewStrip pending={anhaenge.zeilen} onRemove={removeAttachment} />

  <!-- `items-end` ohne Breakpoint: die Knöpfe sollen bei der Schreibmarke stehen,
       sobald der Text mehrzeilig wird. Bei einer Zeile ist es einerlei, weil der
       Textkasten genauso hoch ist wie die Knöpfe (siehe unten). -->
  <div
    class="bg-bg-input relative flex items-end gap-1.5 border border-border px-3 py-2 shadow-[var(--panel-shadow)] backdrop-blur-sm nicht-handy:gap-2 nicht-handy:px-4 nicht-handy:py-3 dark:shadow-none
           {replyTo || anhaenge.zeilen.length > 0 ? 'rounded-b-2xl rounded-t-none' : 'rounded-2xl'}"
  >
    {#if ziehen.zieht}
      <div
        class="bg-primary/15 border-primary text-primary pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed text-sm font-medium"
        data-testid="drop-overlay"
      >
        {m.message_input_drop_files_hint()}
      </div>
    {/if}
    <ComposerAnhaenge
      aktiv={attachmentsEnabled}
      handy={viewport.istHandy}
      {channelId}
      accept={attachmentAccept}
      {aufnahme}
      onDateien={addFiles}
      {onSend}
    />
    <!-- `min-h-*` + `py-*` in zwei Grössen: Der Kasten ist damit jeweils so hoch
         wie die Knöpfe daneben und führt seine Zeile selbst mittig — 44px auf dem
         Handy (`size-11`-Knöpfe: 24px Zeilenhöhe + 2x10px Abstand), 36px ab
         Tablet (`nicht-handy:size-9`: 24px + 2x6px). Weil die Reihe mit `items-end`
         unten ausrichtet, würde ein niederer Kasten mit seiner Unterkante an
         den Knöpfen kleben und die Textzeile unter die Feldmitte rutschen
         (auf dem Handy um gut 4px, gemessen).

         `leading-6` macht es exakt statt nur ungefähr: die Zeile füllt den
         Kasten vollständig aus und sitzt zwangsläufig mittig. -->
    <textarea
      bind:this={textarea}
      rows="1"
      enterkeyhint={viewport.istHandy ? 'enter' : undefined}
      bind:value={text}
      onkeydown={onKeydown}
      oninput={() => { mentionOverlay?.update(); if (text.trim()) onTyping?.(); }}
      onkeyup={onMentionSync}
      onclick={onMentionSync}
      onpaste={onPaste}
      onblur={() => {
        mentionOverlay?.close();
        eingabeFokus = false;
      }}
      onfocus={() => (eingabeFokus = true)}
      placeholder={effectivePlaceholder}
      {disabled}
      class="text-text-bright placeholder:text-text-muted max-h-40 min-h-11 flex-1 resize-none overflow-y-auto border-0 bg-transparent py-2.5 text-base nicht-handy:text-[15px] leading-6 outline-none disabled:cursor-not-allowed disabled:opacity-60 nicht-handy:min-h-9 nicht-handy:py-1.5"
      data-testid="message-input"
    ></textarea>
    <MentionTriggerOverlay
      bind:this={mentionOverlay}
      value={text}
      textareaEl={textarea}
      {guildId}
      onChange={(t) => (text = t)}
    />
    <ComposerEmojiButton onPick={insertEmoji} />
    <ComposerSendButton
      disabled={sendDisabled}
      mikro={!eingabeFokus && !aufnahme.lauf && text.trim().length === 0 && anhaenge.zeilen.length === 0}
      onMikrofon={aufnahmeStart}
    />
  </div>

  {#if !zeichenExtern && limitAktiv && zeichen >= ZEICHEN_WARN_AB}
    <!-- Zeichenzähler für Standalone-Verwender (Watch-/Stream-Chat): unter dem
         Eingabefeld, rechts. Im Chat selbst steht der Zähler oben in der
         reservierten Tippanzeige-Zeile (`zeichenExtern`) — dort verschiebt
         ihr Erscheinen nichts. -->
    <div class="flex justify-end pt-0.5" aria-live="polite">
      <span
        class="text-2xs font-mono {ueberLimit ? 'text-destructive font-semibold' : 'text-text-muted'}"
        data-testid="zeichen-zaehler"
      >
        {zeichen} / {ZEICHEN_LIMIT}
      </span>
    </div>
  {/if}
</form>
