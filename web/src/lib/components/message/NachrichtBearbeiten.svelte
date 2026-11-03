<script lang="ts">
  /**
   * Das Bearbeitungsfeld einer Nachricht, herausgelöst aus `MessageItem`.
   *
   * Rechner und Tablet: Enter speichert, Umschalt+Enter bricht um, Esc bricht
   * ab — der Hinweis darunter sagt das. Am Handy gibt es weder Esc noch
   * Umschalt; dort bricht Enter um wie im Eingabefeld (`MessageInput`), und
   * zwei Knöpfe ersetzen den Hinweis (Bughunt 2026-11-02, Fund 11: Enter
   * speicherte sofort, ein Umbruch war unmöglich, der Hinweis nannte „Esc").
   */
  import { m } from '$lib/paraglide/messages.js';
  import { mitwachsen } from '$lib/utils/mitwachsen';

  let {
    inhalt,
    handy,
    hellAufDunkel = false,
    onSpeichern,
    onAbbrechen
  }: {
    inhalt: string;
    handy: boolean;
    /** Eigene Blase im dunklen Erscheinungsbild: helles Weiß statt Grau. */
    hellAufDunkel?: boolean;
    onSpeichern: (text: string) => void;
    onAbbrechen: () => void;
  } = $props();

  // Bewusst nur der Startwert: das Feld gehört ab hier dem Nutzer.
  // svelte-ignore state_referenced_locally
  let entwurf = $state(inhalt);

  const nebentextFarbe = $derived(hellAufDunkel ? 'dark:text-white/85' : '');

  function speichern() {
    const v = entwurf.trim();
    if (!v || v === inhalt) onAbbrechen();
    else onSpeichern(v);
  }

  function taste(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onAbbrechen();
    } else if (!handy && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      speichern();
    }
  }
</script>

<textarea
  bind:value={entwurf}
  onkeydown={taste}
  use:mitwachsen
  rows="2"
  enterkeyhint={handy ? 'enter' : undefined}
  class="text-text-bright max-h-[60vh] w-full resize-none overflow-y-auto rounded-md border border-border bg-bg-input px-2 py-1 text-[15px] outline-none focus:border-primary"
  data-testid="message-edit-input"
></textarea>
{#if handy}
  <div class="mt-1 flex justify-end gap-2">
    <button
      type="button"
      class="text-text-muted min-h-12 rounded-md px-3 text-sm {nebentextFarbe}"
      onclick={onAbbrechen}
      data-testid="message-edit-cancel"
    >
      {m.message_item_edit_cancel()}
    </button>
    <button
      type="button"
      class="bg-primary text-primary-foreground min-h-12 rounded-md px-4 text-sm font-semibold"
      onclick={speichern}
      data-testid="message-edit-save"
    >
      {m.message_item_edit_save()}
    </button>
  </div>
{:else}
  <div class="text-text-muted mt-1 text-xs {nebentextFarbe}">
    {m.message_item_edit_hint()}
  </div>
{/if}
