<!--
  Die Frage der Bestätigungsseite `/verbinden` (Zustand „bereit“) — rein
  darstellend, ein Stück von `VerbindenKarte.svelte`.

  „bereit“ ist eine FRAGE, keine Bitte, und „Abbrechen“ ist vorausgewählt
  (E5, Schutz gegen untergeschobene Links): Wer einem anderen den Link seines
  eigenen Vorgangs schickt, soll an einem reflexhaften Klick oder Enter
  scheitern. Abbrechen steht deshalb oben, gefüllt und mit dem Fokus.
-->
<script lang="ts" module>
  /** Die Stücke, die die beiden Knöpfe beschreiben (`aria-describedby`): die
   *  Warnung steht hier, Adresse und Code in `VerbindenKarte.svelte`. */
  export const IDS = {
    warnung: 'verbinden-warnung',
    host: 'verbinden-host',
    code: 'verbinden-code'
  } as const;
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { m } from '$lib/paraglide/messages.js';

  let {
    aktion = null,
    konto = '',
    adresseVergeben = false,
    fehlerhinweis,
    onVerbinden,
    onAbbrechen
  }: {
    /** Welche Entscheidung gerade unterwegs ist — `null` = keine. Nur beim
     *  Bestätigen läuft die Prüfung der Cloud (bis ~30 s); ein Abbrechen soll
     *  davon nichts zeigen. */
    aktion?: 'verbinden' | 'ablehnen' | null;
    /** Benutzername des angemeldeten Kontos — wer bestätigt, wird Besitzer. */
    konto?: string;
    /** Die Adresse gehört schon einem anderen Konto: Bestätigen beantragt nur
     *  eine Übernahme mit Widerspruchsfrist. */
    adresseVergeben?: boolean;
    /** Der Fehlerhinweis der Karte — er steht ÜBER den Knöpfen, wo der Blick
     *  nach dem Klick liegt, nicht unter der Angabe zum Konto. */
    fehlerhinweis?: Snippet;
    onVerbinden?: () => void;
    onAbbrechen?: () => void;
  } = $props();

  const busy = $derived(aktion !== null);
  const beschreibung = `${IDS.warnung} ${IDS.host} ${IDS.code}`;

  // Ausdrücklich per focus() statt `autofocus`: Svelte meldet das Attribut als
  // a11y-Warnung (Muster `DropboxCreateFolderDialog.svelte`). Läuft, sobald der
  // Knopf steht — und wieder, wenn eine Anfrage vorbei ist: ein deaktivierter
  // Knopf verliert den Fokus, und nach einem Fehlschlag soll wieder das
  // Abbrechen vorausgewählt sein, nicht nichts.
  let abbrechenKnopf = $state<HTMLElement | null>(null);
  $effect(() => {
    if (!busy) abbrechenKnopf?.focus();
  });
</script>

<div class="flex flex-col gap-2">
  <p class="text-muted-foreground text-sm">{m.verbinden_code_konsole()}</p>
  <p
    id={IDS.warnung}
    class="text-warning flex items-start justify-center gap-1.5 text-sm font-medium"
    data-testid="verbinden-warnung"
  >
    <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
    {m.verbinden_warnung()}
  </p>
</div>

{#if adresseVergeben}
  <p
    class="bg-warning/10 text-warning rounded-lg px-3 py-2 text-sm"
    role="note"
    data-testid="verbinden-adresse-vergeben"
  >
    {m.verbinden_adresse_vergeben()}
  </p>
{/if}

{@render fehlerhinweis?.()}

<div class="flex w-full flex-col gap-2">
  <Button
    bind:ref={abbrechenKnopf}
    class="w-full"
    onclick={onAbbrechen}
    disabled={busy}
    aria-describedby={beschreibung}
    data-testid="verbinden-abbrechen"
  >
    {m.verbinden_abbrechen()}
  </Button>
  <Button
    variant="outline"
    class="w-full"
    onclick={onVerbinden}
    disabled={busy}
    aria-describedby={beschreibung}
    data-testid="verbinden-bestaetigen"
  >
    {aktion === 'verbinden' ? m.verbinden_ja_laeuft() : m.verbinden_ja()}
  </Button>
</div>

{#if aktion === 'verbinden'}
  <p class="text-muted-foreground text-xs" role="status" data-testid="verbinden-dauert">
    {m.verbinden_dauert()}
  </p>
{:else if aktion === 'ablehnen'}
  <p class="text-muted-foreground text-xs" role="status" data-testid="verbinden-bricht-ab">
    {m.verbinden_bricht_ab()}
  </p>
{/if}
{#if konto}
  <p class="text-muted-foreground text-xs">{m.verbinden_angemeldet_als({ konto })}</p>
{/if}
