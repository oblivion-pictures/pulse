<!--
  Platzhalter-Zeilen fürs Laden (Handy): Avatar-Kreis + zwei Balken, sanft
  pulsierend (`motion-safe`, bei „Bewegung reduzieren“ stehen sie still).

  Ersetzt am Handy den Spinner dort, wo gleich eine LISTE kommt — der Blick
  sieht schon, wohin die Zeilen fallen, und beim Eintreffen springt nichts:
  die Maße (Avatar, Polster, Rahmen) sind die der echten Zeile.

    * `variante="chat"` — wie `MobileChatsZeile` (Karte, Avatar 46 px, 68 px hoch).
    * `variante="verlauf"` — Nachrichtenverlauf: schlichte Zeilen, Avatar 36 px.

  `LoadingState` bleibt für alle anderen Stellen (ein einzelner Abschnitt, ein
  Popover) — dort gibt es keine Zeilenform, die man vorwegnehmen könnte.

      <Skelettzeilen variante="chat" anzahl={7} />
-->
<script lang="ts">
  import * as m from '$lib/paraglide/messages';

  let {
    variante = 'chat',
    anzahl = 6,
    class: extraClass = '',
    testId = undefined
  }: {
    variante?: 'chat' | 'verlauf';
    /** Wie viele Zeilen (5–8 füllen ein Handy-Display, ohne zu scrollen). */
    anzahl?: number;
    class?: string;
    testId?: string;
  } = $props();

  // Unterschiedlich lange Balken — gleich lange läsen sich als Tabelle, nicht
  // als Text. Feste Reihen statt Zufall: gleicher Anblick bei jedem Laden.
  const OBEN = ['w-2/5', 'w-1/3', 'w-1/2', 'w-[28%]', 'w-[45%]', 'w-[36%]', 'w-[52%]', 'w-[30%]'];
  const UNTEN = ['w-3/4', 'w-3/5', 'w-2/3', 'w-4/5', 'w-1/2', 'w-[72%]', 'w-[58%]', 'w-[66%]'];

  const alsChat = $derived(variante === 'chat');
</script>

<div
  class="flex flex-col {alsChat ? 'gap-2' : 'gap-1'} motion-safe:animate-pulse {extraClass}"
  role="status"
  aria-busy="true"
  data-testid={testId}
>
  <span class="sr-only">{m.feedback_loading()}</span>
  {#each { length: anzahl } as _, i (i)}
    <div
      class="flex items-center gap-3 {alsChat
        ? 'border-border bg-bg-input rounded-[14px] border p-2.5'
        : 'px-3 py-2'}"
      aria-hidden="true"
    >
      <span
        class="bg-bg-hover shrink-0 rounded-full {alsChat ? 'size-[46px]' : 'size-9'}"
      ></span>
      <span class="flex min-w-0 flex-1 flex-col gap-2">
        <span class="bg-bg-hover h-3 rounded-full {OBEN[i % OBEN.length]}"></span>
        <span class="bg-bg-hover h-2.5 rounded-full {UNTEN[i % UNTEN.length]}"></span>
      </span>
    </div>
  {/each}
</div>
