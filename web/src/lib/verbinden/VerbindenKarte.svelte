<!--
  Inhalt der Bestätigungsseite `/verbinden` (Spec 2026-10-09, E5) — rein
  darstellend: Zustand, Daten und Aktionen kommen als Props aus der Route, die
  Ladelogik steht dort. Muster: `lib/einladung/EinladungKarte.svelte`. Die
  Frage selbst („bereit“) steht in `VerbindenFrage.svelte`.

  Adresse und Code stehen groß da — der Code ist der einzige Beleg, dass
  dieser Link zu dem Server gehört, den man gerade installiert.
-->
<script lang="ts" module>
  export type VerbindenZustand =
    | 'laden'
    | 'eingabe'
    | 'abgemeldet'
    | 'bereit'
    | 'verbunden'
    | 'uebernahme_beantragt'
    | 'abgelehnt'
    | 'unbekannt'
    | 'nachsehen'
    | 'fehler';
</script>

<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import ServerIcon from '@lucide/svelte/icons/server';
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import CircleXIcon from '@lucide/svelte/icons/circle-x';
  import ClockIcon from '@lucide/svelte/icons/clock';
  import LinkOffIcon from '@lucide/svelte/icons/unlink';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import { m } from '$lib/paraglide/messages.js';
  import VerbindenFrage from './VerbindenFrage.svelte';

  let {
    zustand,
    code = null,
    hostname = null,
    konto = '',
    adresseVergeben = false,
    fristBis = '',
    hinweis = null,
    fehlerArt = null,
    busy = false,
    onCode,
    onAnmelden,
    onRegistrieren,
    onVerbinden,
    onAbbrechen,
    onErneut,
    onZuPulse
  }: {
    zustand: VerbindenZustand;
    code?: string | null;
    hostname?: string | null;
    /** Benutzername des angemeldeten Kontos — wer bestätigt, wird Besitzer. */
    konto?: string;
    adresseVergeben?: boolean;
    /** Fristende einer beantragten Übernahme, schon lesbar formatiert. */
    fristBis?: string;
    hinweis?: string | null;
    /** Maschinenlesbarer Grund zum Hinweis (`data-fehler`, für Tests). */
    fehlerArt?: string | null;
    busy?: boolean;
    onCode?: (roh: string) => void;
    onAnmelden?: () => void;
    onRegistrieren?: () => void;
    onVerbinden?: () => void;
    onAbbrechen?: () => void;
    onErneut?: () => void;
    onZuPulse?: () => void;
  } = $props();

  let eingabe = $state('');

  const abschluss = $derived.by(() => {
    switch (zustand) {
      case 'verbunden':
        return {
          titel: m.verbinden_fertig_titel(),
          text: m.verbinden_fertig_text(),
          Symbol: CircleCheckIcon,
          ton: 'bg-success/15 text-success'
        };
      case 'uebernahme_beantragt':
        return {
          titel: m.verbinden_titel(),
          text: m.verbinden_uebernahme_beantragt({ datum: fristBis }),
          Symbol: ClockIcon,
          ton: 'bg-warning/15 text-warning'
        };
      case 'abgelehnt':
        return {
          titel: m.verbinden_abgelehnt_titel(),
          text: m.verbinden_abgelehnt_text(),
          Symbol: CircleXIcon,
          ton: 'bg-bg-hover text-text-muted'
        };
      case 'unbekannt':
        return {
          titel: m.verbinden_unbekannt_titel(),
          text: m.verbinden_unbekannt_text(),
          Symbol: LinkOffIcon,
          ton: 'bg-bg-hover text-text-muted'
        };
      case 'nachsehen':
        return {
          titel: m.verbinden_nachsehen_titel(),
          text: m.verbinden_nachsehen_text(),
          Symbol: TerminalIcon,
          ton: 'bg-primary/15 text-primary'
        };
      default:
        return null;
    }
  });

  const titel = $derived.by(() => {
    if (zustand === 'bereit') return m.verbinden_frage_titel();
    if (zustand === 'fehler') return m.verbinden_fehler_titel();
    return m.verbinden_titel();
  });
</script>

<div
  class="bg-card border-border/60 flex w-full max-w-md flex-col items-center gap-6 rounded-xl border p-8 text-center shadow-2xl"
  data-testid="verbinden-karte"
  data-zustand={zustand}
>
  {#if zustand === 'laden'}
    <div class="bg-bg-hover size-16 animate-pulse rounded-full"></div>
    <div class="flex w-full flex-col items-center gap-2">
      <div class="bg-bg-hover h-6 w-48 animate-pulse rounded"></div>
      <div class="bg-bg-hover h-4 w-32 animate-pulse rounded"></div>
    </div>
    <div class="bg-bg-hover h-9 w-full animate-pulse rounded-md"></div>
  {:else if abschluss}
    {@const Symbol = abschluss.Symbol}
    <div class="flex size-16 items-center justify-center rounded-full {abschluss.ton}">
      <Symbol class="size-7" />
    </div>
    <div class="flex flex-col gap-2">
      <h1 class="text-card-foreground text-xl font-semibold">{abschluss.titel}</h1>
      <p class="text-muted-foreground text-sm" data-testid="verbinden-abschluss-text">
        {abschluss.text}
      </p>
    </div>
    <Button variant="outline" class="w-full" onclick={onZuPulse} data-testid="verbinden-zu-pulse">
      {m.verbinden_zu_pulse()}
    </Button>
  {:else}
    <div class="bg-primary/15 text-primary flex size-16 items-center justify-center rounded-full">
      <ServerIcon class="size-7" />
    </div>
    <h1 class="text-card-foreground text-xl font-semibold">{titel}</h1>

    {#if zustand === 'eingabe'}
      <p class="text-muted-foreground text-sm">{m.verbinden_eingabe_text()}</p>
      <form
        class="flex w-full flex-col gap-2"
        onsubmit={(e) => {
          e.preventDefault();
          onCode?.(eingabe);
        }}
      >
        <Input
          bind:value={eingabe}
          autocomplete="off"
          autocapitalize="characters"
          spellcheck={false}
          placeholder={m.verbinden_eingabe_platzhalter()}
          aria-label={m.verbinden_code_label()}
          class="text-center font-mono text-lg tracking-widest"
          data-testid="verbinden-code-eingabe"
        />
        <Button type="submit" class="w-full" data-testid="verbinden-code-weiter">
          {m.verbinden_eingabe_weiter()}
        </Button>
      </form>
    {:else}
      {#if hostname}
        <p class="text-text-bright break-all text-lg font-semibold" data-testid="verbinden-host">
          {hostname}
        </p>
      {/if}
      {#if code}
        <p
          class="bg-bg-input border-border rounded-lg border px-4 py-2 font-mono text-2xl font-bold tracking-widest"
          data-testid="verbinden-code"
        >
          {code}
        </p>
      {/if}

      {#if zustand === 'bereit'}
        <VerbindenFrage {busy} {konto} {adresseVergeben} {onVerbinden} {onAbbrechen} />
      {:else if zustand === 'abgemeldet'}
        <p class="text-muted-foreground text-sm">{m.verbinden_abgemeldet_text()}</p>
        <div class="flex w-full flex-col gap-2">
          <Button class="w-full" onclick={onAnmelden} data-testid="verbinden-anmelden">
            {m.verbinden_anmelden()}
          </Button>
          <Button
            variant="outline"
            class="w-full"
            onclick={onRegistrieren}
            data-testid="verbinden-registrieren"
          >
            {m.verbinden_registrieren()}
          </Button>
        </div>
      {:else}
        <div class="flex w-full flex-col gap-2">
          <Button class="w-full" onclick={onErneut} data-testid="verbinden-erneut">
            {m.verbinden_erneut()}
          </Button>
          <Button variant="outline" class="w-full" onclick={onZuPulse} data-testid="verbinden-zu-pulse">
            {m.verbinden_zu_pulse()}
          </Button>
        </div>
      {/if}
    {/if}
  {/if}

  {#if hinweis}
    <p
      class="text-destructive text-sm"
      role="alert"
      data-testid="verbinden-hinweis"
      data-fehler={fehlerArt}
    >
      {hinweis}
    </p>
  {/if}
</div>
