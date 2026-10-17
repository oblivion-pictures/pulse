<!--
  Der Absende-Knopf — eigene Datei, seit `MessageInput.svelte` bei der
  Anhang-Etappe geteilt wurde. Unveraendert uebernommen, dieselbe
  `data-testid`.

  Drei beabsichtigte Abweichungen von der Standard-Variante:
  Grösse: `nicht-handy:size-9` (36px) zieht mit Büroklammer und Emoji daneben gleich,
  vorher war dieser eine Knopf 32px. `size-11` (44px) auf dem Handy: die
  Mindestfläche für einen Finger (vorher 40px, darunter lag die Messung).
  Verlauf: `accent-gradient` statt der einfarbigen Fläche — direkt unter den
  eigenen (blauen) Sprechblasen hob sich ein flaches `bg-primary` nicht vom
  Umfeld ab; der leichte Schatten unterstützt das.
  Gesperrt: die Basis blendet auf 50 % aus, was einen blassblauen Geist ergab.
  `disabled:opacity-100` hebt das auf, erst dadurch werden
  `disabled:bg-secondary`/`disabled:text-text-muted` sichtbar — eine echte
  graue Fläche statt „halb da". Die Abweichungen gehören zusammen.

  Fokus: in der iOS-Hülle nimmt der Knopf der Textarea den Fokus NICHT weg
  (`onpointerdown`/`onmousedown` mit `preventDefault`) — sonst klappt die
  Tastatur nach jedem Senden zu, und wer eine Unterhaltung führt, tippt für
  jede Nachricht erneut ins Feld. `click` feuert trotzdem. Das Mikro-Gegenstück
  unten bleibt davon unberührt: es steht nur, solange das Feld OHNE Fokus ist.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import MicIcon from '@lucide/svelte/icons/mic';
  import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';
  import { m } from '$lib/paraglide/messages.js';
  import { isCapacitorIOS } from '$lib/platform/runtime';

  let {
    disabled = false,
    mikro = false,
    onMikrofon
  }: {
    disabled?: boolean;
    /** Wahr = Nachrichtenzeile leer und nicht im Fokus: der Knopf zeigt das
     *  MIKROFON (Tippen startet die Sprachaufnahme) statt des Sendens. */
    mikro?: boolean;
    onMikrofon?: () => void;
  } = $props();

  const fokusBehalten = isCapacitorIOS()
    ? (e: Event) => e.preventDefault()
    : undefined;
</script>

{#if mikro && onMikrofon}
  <Button
    type="button"
    variant="ghost"
    size="icon"
    class="text-text-muted hover:text-text-bright size-11 nicht-handy:size-9"
    onclick={onMikrofon}
    aria-label={m.message_input_hold_to_speak()}
    data-testid="voice-record-button"
  >
    <MicIcon class="size-5" />
  </Button>
{:else}
  <Button
    type="submit"
    size="icon"
    class="accent-gradient size-11 text-white shadow-[0_4px_14px_rgba(37,99,235,0.35)] hover:brightness-110 disabled:bg-none disabled:bg-secondary disabled:text-text-muted disabled:opacity-100 disabled:shadow-none nicht-handy:size-9"
    {disabled}
    onpointerdown={fokusBehalten}
    onmousedown={fokusBehalten}
    data-testid="message-send"
    aria-label={m.message_input_send()}
  >
    <SendHorizontalIcon />
  </Button>
{/if}
