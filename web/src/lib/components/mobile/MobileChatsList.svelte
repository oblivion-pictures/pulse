<script lang="ts">
  /**
   * Der Chats-Bereich des Handys: die privaten Gespräche als Messenger-Liste.
   *
   * **Eine eigene Komponente neben `DMChannelList.svelte`, nicht eine
   * gemeinsame mit zwei Dichten.** Die beiden sind nicht dasselbe in
   * unterschiedlicher Grösse: die Seitenleiste des Rechners ist eine schmale
   * Navigation neben dem Chat und führt zusätzlich zu den Freunden; dieser
   * Bildschirm hat den ganzen Platz, zeigt Vorschautext und Uhrzeit und
   * braucht keinen Freunde-Eintrag, weil Freunde am Telefon ein eigener
   * Bereich sind. Ein gemeinsamer Baustein hätte beide zum kleinsten
   * gemeinsamen Nenner gezwungen.
   *
   * Geteilt wird, was zählt: derselbe Store, dieselben Namensfarben, dieselbe
   * Ungelesen-Rechnung.
   *
   * Trefferliste und „Neues Gespräch" liegen daneben (`MobileChatsSuche`,
   * `NeuesGespraechDialog`) — drei unabhängige Anliegen in einer Datei waren
   * fast das Doppelte der Grössen-Grenze für Svelte-Komponenten.
   */
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import UsersIcon from '@lucide/svelte/icons/users';
  import KopfMenue from './KopfMenue.svelte';
  import MobileChatsZeile from './MobileChatsZeile.svelte';
  import type { ZeilenAktion } from '$lib/components/menu/zeilenAktionen';
  import BereichsKopf from './BereichsKopf.svelte';
  import SuchPille from '$lib/components/SuchPille.svelte';
  import MobileChatsSuche from './MobileChatsSuche.svelte';
  import NeuesGespraechDialog from './NeuesGespraechDialog.svelte';
  import NeueGruppeDialog from './NeueGruppeDialog.svelte';
  import MobileGruppenZeile from './MobileGruppenZeile.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { suchnorm } from '$lib/utils/suche';
  import type { DMChannel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    onSelect,
    onSelectGruppe
  }: {
    onSelect: (dm: DMChannel) => void;
    /** Eine private Gruppe oeffnen (Etappe G). Fehlt der Rueckruf, kommen
     *  keine Gruppen in die Liste — sie waeren sonst nicht antippbar. */
    onSelectGruppe?: (gruppeId: string) => void;
  } = $props();

  /** Gruppen erscheinen nur, wenn die Seite sie auch oeffnen kann. */
  const gruppen = $derived(onSelectGruppe ? privateGruppen.list : []);

  let neuesGespraech = $state(false);
  let neueGruppe = $state(false);
  let suche = $state('');

  const kopfAktionen = $derived<ZeilenAktion[]>([
    {
      id: 'neues-gespraech',
      label: m.chats_compose(),
      icon: PencilIcon,
      onSelect: () => (neuesGespraech = true),
      testid: 'chats-menu-new-chat'
    },
    ...(onSelectGruppe
      ? [
          {
            id: 'neue-gruppe',
            label: m.chats_new_group(),
            icon: UsersIcon,
            onSelect: () => (neueGruppe = true),
            testid: 'chats-menu-new-group'
          }
        ]
      : [])
  ]);

  /** Ab drei ZEICHEN wird gesucht — gerechnet wird über die normalisierte
   *  Eingabe, damit „a -" noch lange keine Suche auslöst. */
  let suchbegriff = $derived.by(() => {
    const norm = suchnorm(suche.trim());
    return norm.length >= 3 ? norm : null;
  });

  // Namen und Bilder der Gegenüber in den Zwischenspeicher holen. Der Store
  // bündelt die Anfragen, mehrfaches Anmelden kostet nichts.
  $effect(() => {
    for (const dm of directMessages.list) userCache.queue(dm.other_user_id);
  });
</script>

<div
  class="glass-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none nicht-handy:rounded-2xl"
  data-testid="mobile-chats-list"
>
  <BereichsKopf titel={m.nav_tab_chats()}>
    {#snippet handlung()}
      <!-- Neues Gespräch / Neue Gruppe: ein Knopf MIT WORT (`BereichsKopf`), der
           die Auswahl als Blatt von unten öffnet. Vorher ein wortloses ⋯ mit
           Popover im Desktop-Stil — am Handy schlecht zu treffen und ohne Hinweis,
           was dahinter liegt. -->
      <KopfMenue wort={m.chats_neu()} icon={PencilIcon} aktionen={kopfAktionen} testid="chats-menu" />
    {/snippet}
  </BereichsKopf>

  <!-- Suchleiste: filtert die Gespräche lokal und durchsucht ab drei Zeichen
       die ganze DM-Historie serverseitig. -->
  <SuchPille bind:value={suche} placeholder={m.chats_search_placeholder()} testid="chats" />

  <nav class="flex flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-3">
    {#if suchbegriff}
      <MobileChatsSuche {suchbegriff} roheEingabe={suche} {onSelect} />
    {:else}
      {#if directMessages.list.length === 0 && gruppen.length === 0}
        <!-- Ein leerer Bildschirm ist eine Aufforderung, keine Stimmung. Das
             Motiv ist der Ping der Bildmarke — hier als das, was er bedeutet:
             es ist noch niemand da, ruf jemanden. -->
        <div class="flex flex-col items-center px-8 pt-16 text-center" data-testid="chats-empty">
          <span class="relative mb-5 flex size-20 items-center justify-center" aria-hidden="true">
            <span class="border-primary/15 absolute size-20 rounded-full border"></span>
            <span class="border-primary/25 absolute size-14 rounded-full border"></span>
            <span class="bg-primary/30 size-2.5 rounded-full"></span>
          </span>
          <p class="text-text-bright text-sm font-semibold">{m.chats_empty_title()}</p>
          <p class="text-text-muted mt-1 text-xs leading-relaxed">{m.chats_empty()}</p>
        </div>
      {/if}
      {#each directMessages.list as dm (dm.id)}
        <MobileChatsZeile {dm} {onSelect} />
      {/each}
      <!-- Private Gruppen unter den Direktnachrichten, in derselben Liste
           aber als eigener Block: die Sortierung der DMs nach Aktualitaet
           soll eine Gruppe nicht dazwischenschieben, solange die Gruppenliste
           keinen Vorschautext und keine Uhrzeit vom Server bekommt. -->
      {#each gruppen as gruppe (gruppe.id)}
        <MobileGruppenZeile {gruppe} onSelect={onSelectGruppe!} />
      {/each}
    {/if}
  </nav>

  <NeuesGespraechDialog bind:open={neuesGespraech} {onSelect} />
  {#if onSelectGruppe}
    <NeueGruppeDialog bind:open={neueGruppe} onErstellt={onSelectGruppe} />
  {/if}
</div>
