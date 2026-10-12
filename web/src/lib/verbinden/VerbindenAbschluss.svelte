<!--
  Die Endzustände der Bestätigungsseite `/verbinden` — rein darstellend, ein
  Stück von `VerbindenKarte.svelte`. Hier gibt es nichts mehr zu bestätigen,
  nur noch den Weg zurück zu Pulse: die Cloud hat den Vorgang beendet (auch bei
  „Übernahme gesperrt“), ein zweiter Klick bekäme 404.
-->
<script lang="ts" module>
  export const ABSCHLUSS_ZUSTAENDE = [
    'verbunden',
    'uebernahme_beantragt',
    'uebernahme_gesperrt',
    'abgelehnt',
    'unbekannt',
    'nachsehen'
  ] as const;
  export type AbschlussZustand = (typeof ABSCHLUSS_ZUSTAENDE)[number];

  export function istAbschluss(zustand: string): zustand is AbschlussZustand {
    return (ABSCHLUSS_ZUSTAENDE as readonly string[]).includes(zustand);
  }
</script>

<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import CircleXIcon from '@lucide/svelte/icons/circle-x';
  import ClockIcon from '@lucide/svelte/icons/clock';
  import LockIcon from '@lucide/svelte/icons/lock';
  import LinkOffIcon from '@lucide/svelte/icons/unlink';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import { m } from '$lib/paraglide/messages.js';

  let {
    zustand,
    fristBis = '',
    onZuPulse
  }: {
    zustand: AbschlussZustand;
    /** Fristende einer beantragten Übernahme bzw. Ende der Sperre, schon lesbar
     *  formatiert. Leer = die Cloud hat kein lesbares Datum genannt. */
    fristBis?: string;
    onZuPulse?: () => void;
  } = $props();

  const inhalt = $derived.by(() => {
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
          titel: m.verbinden_uebernahme_beantragt_titel(),
          text: m.verbinden_uebernahme_beantragt({ datum: fristBis }),
          Symbol: ClockIcon,
          ton: 'bg-warning/15 text-warning'
        };
      case 'uebernahme_gesperrt':
        return {
          titel: m.verbinden_uebernahme_gesperrt_titel(),
          text: fristBis
            ? m.verbinden_uebernahme_gesperrt({ datum: fristBis })
            : m.verbinden_uebernahme_gesperrt_ohne_datum(),
          Symbol: LockIcon,
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
    }
  });
  const Zeichen = $derived(inhalt.Symbol);
</script>

<div class="flex size-16 items-center justify-center rounded-full {inhalt.ton}">
  <Zeichen class="size-7" />
</div>
<div class="flex flex-col gap-2">
  <h1 class="text-card-foreground text-xl font-semibold">{inhalt.titel}</h1>
  <p class="text-muted-foreground text-sm" data-testid="verbinden-abschluss-text">
    {inhalt.text}
  </p>
</div>
<Button variant="outline" class="w-full" onclick={onZuPulse} data-testid="verbinden-zu-pulse">
  {m.verbinden_zu_pulse()}
</Button>
