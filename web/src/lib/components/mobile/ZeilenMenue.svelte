<script lang="ts">
  /**
   * Der sichtbare ⋯-Knopf einer Listenzeile am Handy: öffnet dasselbe Menü wie
   * Rechtsklick und Langdruck als Blatt von unten (`AktionsBlatt`). Langdruck
   * bleibt zusätzlich — er ist nur nicht zu finden, wenn ihn niemand kennt.
   *
   * Der Knopf ist per CSS nur in der Handy-Klasse da (`hidden handy:flex`, keine
   * Viewport-Abfrage); am Rechner bleibt die Zeile unverändert. Er steht als
   * GESCHWISTER neben dem Zeilenknopf (Knopf in Knopf ist kein gültiges HTML)
   * und sitzt rechts, mittig in einem `relative`-Elternelement der Zeile.
   */
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import AktionsBlatt from './AktionsBlatt.svelte';
  import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';
  import { m } from '$lib/paraglide/messages.js';

  let {
    aktionen,
    testid,
    titel
  }: { aktionen: ZeilenAktion[]; testid: string; titel?: string } = $props();

  let offen = $state(false);
</script>

{#if aktionen.some((a) => !a.nurDesktop)}
  <button
    type="button"
    class="text-text-muted hover:bg-bg-hover hover:text-text-bright hidden size-12 items-center justify-center rounded-full transition-colors handy:flex absolute top-1/2 right-1 -translate-y-1/2"
    aria-label={m.zeilen_menue_oeffnen()}
    aria-haspopup="dialog"
    onclick={() => (offen = true)}
    data-testid={testid}
  >
    <EllipsisIcon class="size-5" />
  </button>
  <AktionsBlatt bind:open={offen} {aktionen} {titel} testid={`${testid}-blatt`} />
{/if}
