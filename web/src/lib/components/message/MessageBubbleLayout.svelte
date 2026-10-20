<script lang="ts">
  /**
   * Die Sprechblasen-Hülle (Entwurf D, 2026-10-20): eigene Nachrichten rechts
   * in einer blau getönten Blase, fremde links auf der Panel-Fläche. Beide
   * Farben kommen aus den Theme-Variablen (`--brand`, `--panel`), damit die
   * Blasen im hellen und im dunklen Erscheinungsbild tragen.
   *
   * **Nur für private Gespräche** — DMs und private Gruppen. In einem
   * Community-Kanal reden viele durcheinander, dort tragen Autorname und
   * -farbe die Orientierung. Wer den Bildschirm wechselt, wechselt deshalb die
   * Hülle, nicht den Inhalt: Bearbeiten, Anhänge, Reaktionen, Melden und das
   * Aktionsblatt kommen unverändert aus `MessageItem` herein.
   *
   * In einer DM kein Avatar — mit wem man schreibt, steht im Kopf. In einer
   * Gruppe (`mitAutor`) stehen Bild und Name des Absenders an der ersten
   * Blase seiner Folge.
   *
   * **Die Uhrzeit sitzt IN der Blase** (Entwurf 7a), unten an ihrer Kante,
   * und nur am Ende einer Gruppe. Zuerst stand sie darunter — bei einem
   * Gespräch, in dem sich zwei abwechseln, ist aber jede Nachricht ihre
   * eigene Gruppe, und es standen vier Zeitzeilen zwischen vier Sätzen. Der
   * Blick blieb an den Zahlen hängen statt am Text.
   *
   * Ecken: aussen 8 px, an der Sprech-Seite innerhalb einer Folge 4 px —
   * dadurch liest sich eine Folge als ein Block statt als Kette einzelner
   * Kissen.
   */
  import type { Snippet } from 'svelte';
  import { longpress } from '$lib/utils/longpress';
  import { swipetoreply } from '$lib/utils/swipetoreply';
  import { pfeilDeckkraft } from '$lib/utils/swipeKern';
  import CornerDownRightIcon from '@lucide/svelte/icons/corner-down-right';
  import type { Message } from '$lib/api/types';
  import PinIcon from '@lucide/svelte/icons/pin';
  import { m } from '$lib/paraglide/messages.js';
  import Haekchen from './Haekchen.svelte';
  import type { HaekchenStufe } from '$lib/nachrichten/haekchen';

  let {
    message,
    time,
    eigen,
    haekchen = null,
    isContinuation = false,
    isGroupEnd = true,
    highlight = false,
    breit = false,
    /** Gruppen-Modus: Avatar links, Autorenname in der Blase. */
    mitAutor = false,
    autorName,
    autorFarbe,
    autorAvatar,
    onLongPress,
    onSwipeReply,
    body,
    actions
  }: {
    message: Message;
    time: string;
    /** Vom angemeldeten Nutzer selbst — bestimmt Seite und Farbe. */
    eigen: boolean;
    /** Häkchen-Treppe der EIGENEN Nachricht (`nachrichten/haekchen.ts`);
     *  null = keins (fremde Nachricht). */
    haekchen?: HaekchenStufe | null;
    isContinuation?: boolean;
    isGroupEnd?: boolean;
    highlight?: boolean;
    /** Beim Bearbeiten: Blase auf volle Höchstbreite statt nur so breit wie
     *  ihr Inhalt — sonst bestimmt das Eingabefeld die Breite und bleibt eng. */
    breit?: boolean;
    mitAutor?: boolean;
    autorName?: string;
    autorFarbe?: string | null;
    autorAvatar?: string | null;
    onLongPress: (e: PointerEvent) => void;
    /** Swipe-to-reply (P1.6, nur Touch): löst die Antwort auf diese Nachricht aus. */
    onSwipeReply: () => void;
    body: Snippet;
    actions: Snippet;
  } = $props();

  /** Live-Versatz der Blase (px) — steuert die Pfeil-Deckkraft beim Zug. */
  let swipeOffset = $state(0);

  /** Angepinnt → Nadel neben der Uhrzeit, Blase bekommt einen Hauch Ton. */
  const pinned = $derived(!!message.pinned_at);

  // Die Ecke an der Sprech-Seite wird innerhalb einer Folge flacher. Oben
  // richtet sie sich danach, ob eine Nachricht desselben Absenders darüber
  // steht, unten danach, ob eine darunter folgt.
  let ecken = $derived(
    eigen
      ? `border-radius: 8px ${isContinuation ? '4px' : '8px'} ${isGroupEnd ? '4px' : '8px'} 8px;`
      : `border-radius: ${isContinuation ? '4px' : '8px'} 8px 8px ${isGroupEnd ? '8px' : '4px'};`
  );
</script>

<div
  class="group relative flex px-3 ios:handy:[-webkit-touch-callout:none] ios:handy:select-none {isContinuation ? 'pt-0.5' : 'pt-3'} {eigen
    ? 'justify-end'
    : 'justify-start'}"
  data-testid="message-item"
  data-message-id={message.id}
  data-eigen={eigen}
  use:longpress={{ onLongPress }}
>
  <!-- Avatar-Spalte (nur Gruppen-Modus, nur fremde): auf Fortsetzungs-Zeilen
       bleibt sie leer stehen, damit der Block links bündig bleibt. -->
  {#if mitAutor && !eigen}
    <span class="w-9 shrink-0 self-end">
      {#if !isContinuation}
        {#if autorAvatar}
          <img src={autorAvatar} alt="" class="size-9 rounded-full object-cover" />
        {:else}
          <span
            class="accent-gradient flex size-9 items-center justify-center rounded-full text-xs font-bold text-white"
          >
            {(autorName ?? '?').slice(0, 1).toUpperCase()}
          </span>
        {/if}
      {/if}
    </span>
  {/if}
  <!-- Antwort-Pfeil der Swipe-Geste: an der Zug-Gegenseite, Deckkraft aus
       dem Live-Versatz. `eigen`-Blasen ziehen nach links (Pfeil rechts),
       fremde nach rechts (Pfeil links). -->
  {#if swipeOffset !== 0}
    <span
      class="text-primary absolute inset-y-0 flex items-center {eigen
        ? 'right-4'
        : 'left-4'}"
      style="opacity: {pfeilDeckkraft(swipeOffset)}"
      aria-hidden="true"
    >
      <CornerDownRightIcon class="size-5" />
    </span>
  {/if}
  <div
    class="flex min-w-0 flex-col {breit ? 'w-[78%]' : 'max-w-[78%]'} {eigen ? 'items-end' : 'items-start'}"
    style="touch-action: pan-y"
    use:swipetoreply={{ onReply: onSwipeReply, onMove: (o) => (swipeOffset = o) }}
  >
    <div
      class="min-w-0 px-3 py-2 {breit ? 'w-full' : ''} {eigen
        ? 'border-brand/30 bg-brand/16 text-text-bright border'
        : 'bg-bg-chat text-text-base border border-border'} {pinned ? 'ring-1 ring-primary/40' : ''}"
      class:ring-2={highlight}
      class:ring-primary={highlight}
      style={ecken}
      data-testid="dm-bubble"
    >
      {#if mitAutor && !eigen && !isContinuation}
        <!-- Autor über der Nachricht (Gruppe: mehrere Autoren brauchen die
             Zuordnung; autorFarbe ist ein fertiger Style-String aus
             nameStyle). -->
        <div class="mb-0.5 text-xs font-bold leading-none" style={autorFarbe ?? 'color: var(--brand)'}>
          {autorName}
        </div>
      {/if}
      {@render body()}
      {#if isGroupEnd}
        <!-- Rechtsbündig unter dem Text, in der Blase. Auf der eigenen Blase
             im dunklen Erscheinungsbild gedämpftes Weiss (Grau läge auf dem
             dunklen Blau zu matt), im hellen das normale Grau. -->
        <span
          class="text-text-muted mt-0.5 block text-right text-2xs leading-none {eigen ? 'dark:text-white/70' : ''}"
        >
          {#if pinned}
            <PinIcon
              class="text-primary mr-1 inline size-3 align-baseline"
              aria-label={m.message_pinned_badge()}
              data-testid="message-pinned-badge"
            />
          {/if}
          {#if eigen && haekchen}
            <Haekchen stufe={haekchen} aufBlase />
          {/if}
          {time}</span
        >
      {/if}
    </div>
  </div>
  {@render actions()}
</div>
