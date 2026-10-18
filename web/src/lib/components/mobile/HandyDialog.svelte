<script lang="ts">
  /**
   * Ein Formular-Dialog, der am Handy als Blatt von unten erscheint und überall
   * sonst als zentrierte Karte (`ui/dialog`).
   *
   * **Warum ein Baustein.** Eine zentrierte Karte ist am Telefon die falsche
   * Form: der Daumen erreicht die Mitte schlecht, und die Tastatur schiebt sie
   * über den Rand. Jeder Formular-Dialog sollte darum am Handy ein Blatt sein —
   * ohne dass jeder Dialog die Weiche und das Blatt selbst abschreibt. Die
   * Aufrufer geben Titel, Beschreibung und Inhalt; die Hülle wählt diese
   * Komponente nach Geräteklasse (Handy → `BottomSheet`, Tablet/Desktop →
   * unveränderter `Dialog`).
   *
   * Der Inhalt (`children`) steht in beiden Hüllen; `Dialog.Title`/`Description`
   * gehören NICHT hinein — die setzt dieser Baustein aus `titel`/`beschreibung`
   * (sie brauchen den bits-ui-Kontext, den nur der Dialog liefert). `Dialog.Footer`
   * und alle Formular-Elemente laufen in beiden Hüllen. `testid` hängt am
   * Dialog-Inhalt bzw. am Blatt-Panel (`panelTestid`), genau wie vorher; die
   * äussere Blatt-Hülle trägt `${testid}-blatt`.
   *
   * Der Aufrufer behält `open` und reagiert auf `onOpenChange`.
   */
  import type { Snippet } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import BottomSheet from './BottomSheet.svelte';

  let {
    open,
    onOpenChange,
    testid,
    titel,
    beschreibung,
    class: klasse,
    children
  }: {
    open: boolean;
    onOpenChange: (offen: boolean) => void;
    /** `data-testid` des Dialog-Inhalts bzw. des Blattes. */
    testid: string;
    titel: string;
    beschreibung?: string;
    /** Klassen der Dialog-Karte (am Handy ohne Wirkung). */
    class?: string;
    children: Snippet;
  } = $props();
</script>

{#if viewport.isMobile}
  <BottomSheet
    {open}
    testid={`${testid}-blatt`}
    closeLabel={m.handy_dialog_schliessen()}
    ariaLabel={titel}
    panelTestid={testid}
    panelClass="bg-popover text-popover-foreground border-border relative flex max-h-[85dvh] flex-col gap-4 overflow-y-auto rounded-t-[22px] border-t p-4 pb-[max(1rem,var(--safe-bottom))] shadow-2xl"
    onClose={() => onOpenChange(false)}
  >
    <div class="bg-border mx-auto h-1 w-9 shrink-0 rounded-full"></div>
    <div class="flex flex-col gap-1.5">
      <h2 class="text-text-bright text-lg font-semibold">{titel}</h2>
      {#if beschreibung}
        <p class="text-text-muted text-sm">{beschreibung}</p>
      {/if}
    </div>
    {@render children()}
  </BottomSheet>
{:else}
  <Dialog.Root {open} {onOpenChange}>
    <Dialog.Content class={klasse} data-testid={testid}>
      <Dialog.Header>
        <Dialog.Title>{titel}</Dialog.Title>
        {#if beschreibung}
          <Dialog.Description>{beschreibung}</Dialog.Description>
        {/if}
      </Dialog.Header>
      {@render children()}
    </Dialog.Content>
  </Dialog.Root>
{/if}
