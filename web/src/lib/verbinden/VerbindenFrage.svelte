<!--
  Die Frage der Bestätigungsseite `/verbinden` (Zustand „bereit“) — rein
  darstellend, ein Stück von `VerbindenKarte.svelte`.

  „bereit“ ist eine FRAGE, keine Bitte, und „Abbrechen“ ist vorausgewählt
  (E5, Schutz gegen untergeschobene Links): Wer einem anderen den Link seines
  eigenen Vorgangs schickt, soll an einem reflexhaften Klick oder Enter
  scheitern. Abbrechen steht deshalb oben, gefüllt und mit dem Fokus.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { m } from '$lib/paraglide/messages.js';

  let {
    busy = false,
    konto = '',
    adresseVergeben = false,
    onVerbinden,
    onAbbrechen
  }: {
    busy?: boolean;
    /** Benutzername des angemeldeten Kontos — wer bestätigt, wird Besitzer. */
    konto?: string;
    /** Die Adresse gehört schon einem anderen Konto: Bestätigen beantragt nur
     *  eine Übernahme mit Widerspruchsfrist. */
    adresseVergeben?: boolean;
    onVerbinden?: () => void;
    onAbbrechen?: () => void;
  } = $props();

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

<div class="flex w-full flex-col gap-2">
  <Button
    bind:ref={abbrechenKnopf}
    class="w-full"
    onclick={onAbbrechen}
    disabled={busy}
    data-testid="verbinden-abbrechen"
  >
    {m.verbinden_abbrechen()}
  </Button>
  <Button
    variant="outline"
    class="w-full"
    onclick={onVerbinden}
    disabled={busy}
    data-testid="verbinden-bestaetigen"
  >
    {busy ? m.verbinden_ja_laeuft() : m.verbinden_ja()}
  </Button>
</div>

{#if busy}
  <p class="text-muted-foreground text-xs" role="status" data-testid="verbinden-dauert">
    {m.verbinden_dauert()}
  </p>
{/if}
{#if konto}
  <p class="text-muted-foreground text-xs">{m.verbinden_angemeldet_als({ konto })}</p>
{/if}
