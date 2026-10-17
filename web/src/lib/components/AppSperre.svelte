<!--
  Sperrfläche der App (iOS-Liste Punkt 42).

  **Deckend, und zwar absichtlich** — anders als der Verbindungs-Hinweis, der
  nur ein Streifen ist. Eine Sperre, durch die man den Inhalt lesen kann, ist
  keine Sperre; hier ist das Verdecken die ganze Funktion.

  **Die Abfrage läuft von selbst an**, nicht erst auf Knopfdruck: wer die App
  öffnet, will hinein, und ein zusätzlicher Tipp wäre ein Tipp zu viel. Der
  Knopf darunter ist für den zweiten Versuch — Face ID erkennt nicht immer
  beim ersten Mal, und ein weggetippter Dialog darf keine Sackgasse sein.

  **Ein Abbruch ist keine Fehlermeldung.** Wer die Abfrage wegtippt, hat nicht
  falsch geantwortet, sondern nicht geantwortet. Dann steht hier weiter die
  Sperre mit dem Erneut-Knopf, nichts Rotes.

  **Bis zum 2026-10-11 war sie durchsichtig** (iOS-Bughunt 2, F1), obwohl
  hier „deckend" stand: `bg-bg-base` ist `transparent` — der Seitengrund der
  App liegt mit Absicht auf dem Body, nicht auf den Flächen —, und unter der
  Sperre war die DM-Liste lesbar, nach einer Mitteilung der offene Chat.
  Dazu lagen Toasts (z-index 999999999) und portalierte Flächen wie die
  Lightbox darüber, und die App darunter blieb mit Tab erreichbar. Deshalb
  jetzt drei Dinge, dasselbe Muster wie der Sichtschutz
  (`remote/sichtschutz.ts`): der Body-Verlauf als eigene, deckende Fläche;
  ein z-index über den Toasts, die zusätzlich ausgeblendet werden; und
  `inert` auf allem anderen.

  Was die Sperre NICHT ist: Schutz der Daten vor jemandem, der das Gerät hat.
  Der lokale Verlauf liegt in der IndexedDB und hängt am Dateischutz des
  Containers, nicht an dieser Abfrage. Begründung samt der Entscheidung „nur
  beim Neustart" in `platform/appSperre.svelte.ts`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import LockIcon from '@lucide/svelte/icons/lock';
  import { Button } from '$lib/components/ui/button';
  import { m } from '$lib/paraglide/messages.js';
  import { appSperre } from '$lib/platform/appSperre.svelte';
  import { abmelden } from '$lib/auth/abmelden';
  import { restlicheAppSperren } from '$lib/remote/sichtschutz';

  onMount(() => {
    void appSperre.entsperren(m.appsperre_text());
    const sichtbar = () => {
      if (document.visibilityState === 'visible') void appSperre.codeNeuPruefen();
    };
    document.addEventListener('visibilitychange', sichtbar);
    return () => document.removeEventListener('visibilitychange', sichtbar);
  });

  let wurzel = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!appSperre.gesperrt || !wurzel) return;
    // Den Fokus herüberholen, bevor der Rest stillgelegt wird — sonst bliebe
    // er in einem Feld, das man nicht mehr sieht.
    wurzel.focus();
    const auf = restlicheAppSperren(wurzel);
    // `inert` nimmt die Bedienbarkeit, nicht die Lesbarkeit: der Toaster
    // wird zusätzlich ausgeblendet (Regel unten).
    document.documentElement.dataset.appSperre = '';
    return () => {
      delete document.documentElement.dataset.appSperre;
      auf();
    };
  });
</script>

{#if appSperre.gesperrt}
  <div
    bind:this={wurzel}
    tabindex="-1"
    class="app-sperre fixed inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center outline-none"
    role="dialog"
    aria-modal="true"
    aria-label={m.appsperre_titel()}
    data-testid="app-sperre"
  >
    <div
      class="bg-primary/15 text-primary flex size-16 items-center justify-center rounded-full"
    >
      <LockIcon class="size-7" />
    </div>
    <h1 class="text-text-bright text-lg font-semibold">{m.appsperre_titel()}</h1>
    <p class="text-text-muted max-w-xs text-sm">{m.appsperre_text()}</p>
    {#if appSperre.keinCode}
      <p class="text-destructive max-w-xs text-sm" data-testid="app-sperre-kein-code">
        {m.appsperre_kein_code_hinweis()}
      </p>
    {/if}
    {#if appSperre.fehler}
      <p class="text-destructive max-w-xs text-sm" data-testid="app-sperre-fehler">
        {appSperre.fehler}
      </p>
    {/if}
    {#if !appSperre.keinCode}
    <Button
      class="min-h-12 w-full max-w-xs"
      disabled={appSperre.laeuft}
      onclick={() => void appSperre.entsperren(m.appsperre_text())}
      data-testid="app-sperre-entsperren"
    >
      {appSperre.laeuft ? m.appsperre_laeuft() : m.appsperre_knopf()}
    </Button>
    {/if}
    <!-- Der Ausweg: ohne ihn käme aus einer Sperre, die nicht mehr aufgeht
         (Face ID gesperrt, Code entfernt), nur die Neuinstallation heraus.
         Abmelden räumt die Sitzung ab und nimmt die Sperre mit; wieder hinein
         kommt man nur über eine normale Anmeldung. Unauffällig, solange
         entsperrt werden kann; bei fehlendem Code der einzige Weg. -->
    <button
      class="{appSperre.keinCode ? 'text-text-bright text-sm font-semibold' : 'text-text-muted text-xs'} min-h-11 px-4 underline underline-offset-2"
      onclick={() => void appSperre.abmeldenUndAufheben(abmelden)}
      data-testid="app-sperre-abmelden"
    >
      {m.appsperre_abmelden()}
    </button>
  </div>
{/if}

<style>
  /* Der Seitengrund der App (Body-Verlauf, hell wie dunkel deckend) als eigene
     Fläche — `bg-bg-base` ist durchsichtig. Der z-index liegt über dem der
     Toasts (svelte-sonner: 999999999) und damit über allem, was die App
     portaliert. */
  .app-sperre {
    background: var(--bg-grad);
    z-index: 1000000000;
  }
  :global(html[data-app-sperre] [data-sonner-toaster]) {
    display: none !important;
  }
</style>
