<script lang="ts">
  /**
   * Die Handlung oben rechts in einer Bereichs-Kopfzeile, die mehrere Dinge
   * anbietet: ein Knopf MIT WORT (`BereichsKopf`: ein blosses Symbol in einer
   * Kopfzeile ist ein Rätsel), der die Auswahl als Blatt von unten öffnet
   * (`AktionsBlatt`). Löst das wortlose ⋯ mit Popover im Desktop-Stil ab.
   * Trefferfläche 48 dp (`mobile-treffflaechen.spec.ts` misst sie).
   */
  import type { Component } from 'svelte';
  import AktionsBlatt from './AktionsBlatt.svelte';
  import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';

  let {
    wort,
    icon: Icon,
    aktionen,
    testid
  }: {
    wort: string;
    icon: Component<{ class?: string }>;
    aktionen: ZeilenAktion[];
    testid: string;
  } = $props();

  let offen = $state(false);
</script>

<button
  type="button"
  class="text-text-bright hover:bg-bg-hover border-border bg-bg-input flex min-h-12 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors"
  aria-haspopup="dialog"
  onclick={() => (offen = true)}
  data-testid={testid}
>
  <Icon class="size-4" />
  {wort}
</button>
<AktionsBlatt bind:open={offen} {aktionen} testid={`${testid}-blatt`} />
